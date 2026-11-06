// Operação dos avisos: falha final visível e alertada, reenvio do mesmo job,
// erro ambíguo sem retry automático, diagnóstico restrito ao síndico, push por usuário.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('falhas, alertas, reenvio, diagnóstico e inscrição push', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const admin = await db.createUser('sindico@ops.invalid');
    const port = await db.createUser('porteiro@ops.invalid');
    const mor = await db.createUser('morador@ops.invalid');
    const other = await db.createUser('outro@ops.invalid');
    const { tenant_id: T } = await db.rpc(admin, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Ops', p_slug: 'ops-cond',
      p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
    const [{ id: unit }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'101') returning id", [T]);
    for (const [u, email, role, un] of [[port, 'porteiro@ops.invalid', 'porteiro', null], [mor, 'morador@ops.invalid', 'morador', unit]]) {
      const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: email, p_role: role, p_unit: un, p_permissions: '{}' });
      await db.rpc(u, 'accept_invitation', { p_token: inv.token });
    }
    const pkg = await db.rpc(port, 'receive_package', { p_tenant: T, p_idempotency_key: 'ops-key-0001', p_unit: unit, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    const [job] = await db.sql("select id from notification_jobs where ref_id=$1 and channel='email'", [pkg.id]);
    const complete = (status, error, final = false) => db.service('select public.complete_notification_job($1,$2,null,$3,$4)', [job.id, status, error, final]);

    // Número inválido: falha final na primeira tentativa, alerta ao síndico (central + push), nunca ao morador.
    await db.service("update notification_jobs set status='sending', attempts=1 where id=$1", [job.id]);
    await complete('failed', 'Evolution HTTP 400: número inválido ou sem WhatsApp', true);
    const [j1] = await db.sql('select status, attempts from notification_jobs where id=$1', [job.id]);
    assert.deepEqual([j1.status, j1.attempts >= 5], ['failed', true]);
    assert.equal((await db.as(admin, "select * from notifications where kind='ops_alert'")).length, 1);
    assert.equal((await db.as(mor, "select * from notifications where kind='ops_alert'")).length, 0);
    assert.equal((await db.sql("select * from notification_jobs where event='ops_alert' and recipient=$1", [admin])).length, 1);

    // Diagnóstico só para administrador; destinatário mascarado.
    const h = await db.rpc(admin, 'notification_health', { p_tenant: T });
    assert.equal(h.failures[0].final, true);
    assert.ok(!JSON.stringify(h).includes('morador@ops.invalid'));
    await assert.rejects(db.rpc(port, 'notification_health', { p_tenant: T }), /permissão/i);
    await assert.rejects(db.rpc(mor, 'retry_notification_job', { p_tenant: T, p_job: job.id }), /permissão/i);

    // Reenvio reaproveita o mesmo job (não cria outro recebimento nem outra encomenda).
    const before = (await db.sql('select count(*)::int n from notification_jobs'))[0].n;
    await db.rpc(admin, 'retry_notification_job', { p_tenant: T, p_job: job.id });
    const [j2] = await db.sql('select status, attempts from notification_jobs where id=$1', [job.id]);
    assert.deepEqual([j2.status, j2.attempts], ['queued', 0]);
    assert.equal((await db.sql('select count(*)::int n from notification_jobs'))[0].n, before);
    await assert.rejects(db.rpc(admin, 'retry_notification_job', { p_tenant: T, p_job: job.id }), /falha final/);

    // Tempo esgotado após envio: ambíguo, não repete sozinho.
    await db.service("update notification_jobs set status='sending', attempts=1 where id=$1", [job.id]);
    await complete('failed', 'ambiguous: tempo esgotado após envio à Evolution');
    const claimed = await db.service('select id from public.claim_notification_jobs(50)');
    assert.ok(!claimed.some((r) => r.id === job.id));

    // Falha transitória: reagenda com retry (não final).
    await db.service("update notification_jobs set status='sending', attempts=1 where id=$1", [job.id]);
    await complete('failed', 'rede: indisponível');
    const [j3] = await db.sql('select attempts from notification_jobs where id=$1', [job.id]);
    assert.equal(j3.attempts, 1);

    // Batimento do worker só pelo backend.
    await assert.rejects(db.rpc(admin, 'record_worker_run', { p_name: 'tick', p_result: {} }), /permission denied/);
    await db.service("select public.record_worker_run('tick', '{}'::jsonb)");
    assert.ok((await db.rpc(admin, 'notification_health', { p_tenant: T })).worker_last_run);

    // Push: mesmo navegador, outra pessoa → endpoint passa a ser só do novo usuário.
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    const keys = { p_tenant: T, p_endpoint: endpoint, p_p256dh: 'p'.repeat(40), p_auth: 'a'.repeat(16), p_user_agent: 'teste' };
    await db.rpc(mor, 'register_push_subscription', keys);
    await db.rpc(port, 'register_push_subscription', keys);
    const subs = await db.sql('select user_id from push_subscriptions where endpoint=$1', [endpoint]);
    assert.deepEqual(subs.map((s) => s.user_id), [port]);
    await assert.rejects(db.rpc(other, 'register_push_subscription', keys), /permissão/i);
    await assert.rejects(db.rpc(mor, 'register_push_subscription', { ...keys, p_endpoint: 'https://evil.example/x' }), /inválida/);

    // Teste de WhatsApp: exige permissão de configurações e canal conectado.
    await assert.rejects(db.rpc(port, 'whatsapp_test_gate', { p_tenant: T, p_last4: '1234' }), /permissão/i);
    await assert.rejects(db.rpc(admin, 'whatsapp_test_gate', { p_tenant: T, p_last4: '1234' }), /não está conectado/);
    await db.service("insert into tenant_integrations(tenant_id,provider,enabled,config) values($1,'whatsapp_evolution',true,'{\"instance\":\"pp-x\"}')", [T]);
    assert.equal(await db.rpc(admin, 'whatsapp_test_gate', { p_tenant: T, p_last4: '1234' }), 'pp-x');
    await assert.rejects(db.rpc(admin, 'whatsapp_test_gate', { p_tenant: T, p_last4: '1234' }), /2 minutos/);
  } finally { await db.raw.close(); }
});
