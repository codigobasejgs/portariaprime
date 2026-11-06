// Lembretes de encomenda parada: desligado por padrão, após X horas, intervalo,
// janela de horário local, máximo, mesmos destinatários da chegada (sem duplicar
// contato compartilhado) e encerramento imediato na retirada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('lembretes: regra por condomínio, destinatários, dedupe e encerramento', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const uuid = () => crypto.randomUUID();
    const [admin, port, m1, m2, outro] = await Promise.all(['sindico@rem.invalid', 'porteiro@rem.invalid', 'morador1@rem.invalid', 'morador2@rem.invalid', 'outro@rem.invalid'].map((e) => db.createUser(e)));
    // 2026-10-22 12:00 UTC = 09:00 em São Paulo.
    db.setNow('2026-10-22T12:00:00Z');
    const T = (await db.rpc(admin, 'provision_tenant', { p_request_id: uuid(), p_name: 'Rem', p_slug: 'rem-cond', p_document: '11444777000161',
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const [{ id: unit }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'101') returning id", [T]);
    const [{ id: unit2 }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'102') returning id", [T]);
    for (const [u, email, role, un] of [[port, 'porteiro@rem.invalid', 'porteiro', null], [m1, 'morador1@rem.invalid', 'morador', unit],
      [m2, 'morador2@rem.invalid', 'morador', unit], [outro, 'outro@rem.invalid', 'morador', unit2]]) {
      const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: email, p_role: role, p_unit: un, p_permissions: '{}' });
      await db.rpc(u, 'accept_invitation', { p_token: inv.token });
    }
    // Contato compartilhado (mesmo telefone em dois cadastros) recebe uma vez só.
    await db.sql("update resident_contacts set phone='+5511999990000' where tenant_id=$1 and unit_id=$2", [T, unit]);
    const receive = (key) => db.rpc(port, 'receive_package', { p_tenant: T, p_idempotency_key: key, p_unit: unit, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    const pkg = await receive('rem-key-0001');
    const pkg2 = await receive('rem-key-0002');
    const tick = () => db.service('select public.enqueue_package_reminders(200) as r').then((r) => r[0].r);
    const jobs = (p) => db.sql("select channel, recipient, ref_id, status from notification_jobs where event='package_reminder' and payload->>'package_id'=$1 order by ref_id, channel, recipient", [p]);
    const at = (iso) => db.setNow(iso);

    // Desligado por padrão: nada.
    at('2026-10-25T12:00:00Z');
    assert.deepEqual(await tick(), { packages: 0, jobs: 0 });
    // Só quem tem "settings" configura; colunas fora da lista não são graváveis.
    await assert.rejects(db.as(port, "update tenant_settings set reminder_enabled=true where tenant_id=$1 returning 1", [T]).then((r) => { if (!r.length) throw new Error('bloqueado'); }), /bloqueado|permission/);
    await assert.rejects(db.as(admin, 'update tenant_settings set reminder_start_hour=20, reminder_end_hour=8 where tenant_id=$1', [T]), /check/);
    await db.as(admin, `update tenant_settings set reminder_enabled=true, reminder_after_hours=24, reminder_interval_hours=12,
      reminder_start_hour=8, reminder_end_hour=20, reminder_max=2 where tenant_id=$1`, [T]);

    // Antes de X horas: nada. (recebida 22/10 09:00 local; 22/10 20:00 UTC = 17:00 local, 11 h depois)
    at('2026-10-22T20:00:00Z');
    assert.equal((await tick()).packages, 0);
    // Fora da janela local (23/10 23:30 local = 24/10 02:30 UTC): nada.
    at('2026-10-24T02:30:00Z');
    assert.equal((await tick()).packages, 0);
    // Dentro da janela e após 24 h: 1º lembrete para as 2 encomendas.
    at('2026-10-24T11:00:00Z');
    assert.equal((await tick()).packages, 2);
    let j = await jobs(pkg.id);
    // Mesmos destinatários da chegada: 1 WhatsApp (telefone compartilhado), 2 e-mails, 2 push. Nada para a outra unidade.
    assert.deepEqual(j.map((x) => x.channel).sort(), ['email', 'email', 'push', 'push', 'whatsapp']);
    assert.ok(j.every((x) => x.ref_id === `${pkg.id}:1`));
    assert.ok(!j.some((x) => x.recipient === outro));
    assert.equal((await db.as(outro, "select id from notifications where kind='package_reminder'")).length, 0);
    assert.equal((await db.as(m1, "select id from notifications where kind='package_reminder' and package_id=$1", [pkg.id])).length, 1);
    // Destinatário revalidado pelo worker.
    for (const x of await db.sql("select id from notification_jobs where event='package_reminder'")) {
      assert.equal((await db.service('select public.notification_is_authorized($1) ok', [x.id]))[0].ok, true);
    }
    // Rodar de novo (ou em paralelo) antes do intervalo não duplica.
    assert.equal((await tick()).packages, 0);
    at('2026-10-24T18:00:00Z');
    assert.equal((await tick()).packages, 0);
    // Intervalo vencido mas fora da janela (20:30 local): espera a manhã.
    at('2026-10-24T23:30:00Z');
    assert.equal((await tick()).packages, 0);
    // Após o intervalo, dentro da janela: 2º lembrete com ref próprio.
    at('2026-10-25T12:00:00Z');
    assert.equal((await tick()).packages, 2);
    assert.equal((await jobs(pkg.id)).filter((x) => x.ref_id === `${pkg.id}:2`).length, 5);

    // Retirada encerra na hora: lembrete pendente desativado, nenhum novo, worker recusa.
    const sig = `${T}/packages/${pkg.id}/signature-sig00001.png`, hand = `${T}/packages/${pkg.id}/handover-han00001.jpg`;
    for (const p of [sig, hand]) await db.service("insert into storage.objects (bucket_id,name,owner) values ('tenant-private',$1,$2)", [p, port]);
    await db.rpc(port, 'deliver_package', { p_tenant: T, p_package: pkg.id, p_request: uuid(), p_qr: null, p_picked_up_by: 'Pessoa',
      p_recipient_kind: 'morador', p_signature_path: sig, p_item_photo_path: hand, p_manual_reason: 'Documento conferido na portaria' });
    j = await jobs(pkg.id);
    assert.ok(j.every((x) => x.status === 'disabled'), JSON.stringify(j));
    const [left] = await db.sql("select id from notification_jobs where event='package_reminder' and ref_id like $1 limit 1", [`${pkg2.id}:%`]);
    assert.equal((await db.service('select public.notification_is_authorized($1) ok', [left.id]))[0].ok, true);
    const [gone] = await db.sql("select id from notification_jobs where event='package_reminder' and ref_id like $1 limit 1", [`${pkg.id}:%`]);
    assert.equal((await db.service('select public.notification_is_authorized($1) ok', [gone.id]))[0].ok, false);
    // Máximo de 2 atingido para a outra encomenda: nada mais.
    at('2026-10-26T15:00:00Z');
    assert.equal((await tick()).packages, 0);

    // Guarda do outbox: ref sem número ou de encomenda retirada não entra na fila.
    await db.service("insert into notification_jobs (tenant_id,event,channel,recipient,ref_id,payload) values ($1,'package_reminder','push',$2,$3,$4)",
      [T, m1, pkg2.id, JSON.stringify({ package_id: pkg2.id })]);
    await db.service("insert into notification_jobs (tenant_id,event,channel,recipient,ref_id,payload) values ($1,'package_reminder','push',$2,$3,$4)",
      [T, m1, `${pkg.id}:9`, JSON.stringify({ package_id: pkg.id })]);
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='package_reminder' and ref_id in ($1,$2)", [pkg2.id, `${pkg.id}:9`]))[0].n, 0);

    // Chegada continua igual (atalho de 2 argumentos): ref = id, sem duplicar na repetição.
    const pkg3 = await receive('rem-key-0003');
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='package_received' and ref_id=$1", [pkg3.id]))[0].n, 5);

    // Somente o backend chama a geração.
    await assert.rejects(db.rpc(admin, 'enqueue_package_reminders', { p_limit: 10 }), /permission denied/);
  } finally { await db.raw.close(); }
});
