// Conversas do WhatsApp no painel (20261117000400): só configurações + plano com WhatsApp; envio conta franquia e
// auditoria; identificação da conversa só com refs do próprio condomínio; bucket só na pasta out/ do condomínio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('gate, franquia, auditoria, identificação e bucket', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const sind = await db.createUser('s@chat.invalid'), sindB = await db.createUser('b@chat.invalid'), port = await db.createUser('p@chat.invalid');
    const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: slug, p_slug: slug, p_document: doc,
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
    const A = await prov(sind, 'chat-a', '11444777000161'), B = await prov(sindB, 'chat-b', '04252011000110');
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'porteiro','{}','active')", [A, port]);
    const has = (await db.sql('select app.has_feature($1, $2) ok', [A, 'whatsapp']))[0].ok;

    // Porteiro e síndico de outro condomínio: nada.
    for (const [who, T] of [[port, A], [sindB, A]]) await assert.rejects(db.rpc(who, 'whatsapp_chat_gate', { p_tenant: T, p_action: 'read' }), /configurações/);
    await assert.rejects(db.rpc(sind, 'whatsapp_chat_gate', { p_tenant: A, p_action: 'apagar' }), has ? /inválida/ : /configurações/);
    if (!has) return;   // plano sem WhatsApp: só a negação acima vale

    const audits = async () => (await db.sql("select count(*)::int n from audit_logs where tenant_id=$1 and action='whatsapp.chat_send'", [A]))[0].n;
    const used = async () => (await db.sql("select coalesce(sum(used),0)::int n from usage_counters where tenant_id=$1 and metric='whatsapp'", [A]))[0].n;
    assert.equal(await db.rpc(sind, 'whatsapp_chat_gate', { p_tenant: A, p_action: 'read' }), true);
    assert.deepEqual([await audits(), await used()], [0, 0], 'ler não consome nem audita');
    for (const k of ['text', 'image', 'video', 'document']) await db.rpc(sind, 'whatsapp_chat_gate', { p_tenant: A, p_action: k });
    assert.deepEqual([await audits(), await used()], [4, 4]);
    const [au] = await db.sql("select data from audit_logs where action='whatsapp.chat_send' order by id desc limit 1");
    assert.deepEqual(au.data, { kind: 'document' }, 'auditoria sem conteúdo');
    // Franquia esgotada: envio barrado.
    await db.sql("update usage_counters set used = 999999 where tenant_id=$1 and metric='whatsapp'", [A]);
    await assert.rejects(db.rpc(sind, 'whatsapp_chat_gate', { p_tenant: A, p_action: 'text' }), /Franquia/);

    // Identificação: ref do aviso de A leva ao contato; ref de B não aparece para A.
    const [{ id: unit }] = await db.sql("insert into units (tenant_id, block, label) values ($1,'A','101') returning id", [A]);
    await db.sql("insert into resident_contacts (tenant_id, unit_id, name, phone) values ($1,$2,'Ana Fictícia','+5511988887777')", [A, unit]);
    // O outbox descarta inserção direta sem autorização (guard): desliga só o gatilho para montar o histórico.
    await db.sql('alter table notification_jobs disable trigger user');
    const job = async (T, ref) => {
      const id = crypto.randomUUID();
      await db.sql("insert into notification_jobs (id, tenant_id, event, channel, recipient, ref_id, status) values ($1,$2,'package_received','whatsapp','+5511988887777',$3,'accepted')", [id, T, crypto.randomUUID()]);
      await db.sql('insert into notification_attempts (job_id, tenant_id, ok, provider_ref) values ($1,$2,true,$3)', [id, T, ref]);
    };
    await job(A, '3EBAAAAAAAAAAAAAAAAAA1'); await job(B, '3EBBBBBBBBBBBBBBBBBBB2');
    await db.sql('alter table notification_jobs enable trigger user');
    const who = await db.as(sind, 'select * from public.whatsapp_chat_who($1, $2)', [A, '{3EBAAAAAAAAAAAAAAAAAA1,3EBBBBBBBBBBBBBBBBBBB2}']);
    assert.equal(who.length, 1);
    assert.deepEqual([who[0].full_name, who[0].phone], ['Ana Fictícia', '+5511988887777']);
    assert.match(who[0].unit, /101/);
    await assert.rejects(db.rpc(port, 'whatsapp_chat_who', { p_tenant: A, p_refs: '{3EBAAAAAAAAAAAAAAAAAA1}' }), /configurações/);

    // Bucket: síndico grava só em <A>/out/; nada em in/ nem em outro condomínio; anon e porteiro não.
    assert.equal((await db.sql("select file_size_limit::int n from storage.buckets where id='tenant-chat'"))[0].n, 20971520, 'anexo até 20 MB');
    const put = (who, name) => db.as(who, "insert into storage.objects (bucket_id, name) values ('tenant-chat', $1)", [name]);
    await put(sind, `${A}/out/x.jpg`);
    await assert.rejects(put(sind, `${A}/in/x.jpg`), /row-level security/);
    await assert.rejects(put(sind, `${B}/out/x.jpg`), /row-level security/);
    await assert.rejects(put(port, `${A}/out/y.jpg`), /row-level security/);
    assert.equal((await db.as(sind, "select count(*)::int n from storage.objects where bucket_id='tenant-chat'"))[0].n, 0, 'sem leitura direta');
    // Retenção: anexo não enviado (out/) sai em 1 dia; mídia aberta (in/) em 7.
    await db.sql(`insert into storage.objects (bucket_id, name, created_at) values ('tenant-chat', $1, now() - interval '2 days'),
      ('tenant-chat', $2, now() - interval '2 days'), ('tenant-chat', $3, now() - interval '8 days')`, [`${A}/out/velho.jpg`, `${A}/in/AAA.jpg`, `${A}/in/BBB.jpg`]);
    const exp = (await db.service('select public.whatsapp_chat_expired(100) r'))[0].r;
    assert.deepEqual([...exp].sort(), [`${A}/in/BBB.jpg`, `${A}/out/velho.jpg`]);
    const [g] = await db.sql(`select has_function_privilege('anon', 'public.whatsapp_chat_gate(uuid,text)', 'execute') a,
      has_function_privilege('authenticated', 'public.whatsapp_chat_expired(int)', 'execute') b`);
    assert.deepEqual([g.a, g.b], [false, false]);
  } finally { await db.raw.close(); }
});
