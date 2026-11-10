// Migration 20261110000100: histórico de envios aos moradores, por unidade/morador/canal, isolado por condomínio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('notification_log: síndico vê envios por unidade e morador; porteiro, morador, outro condomínio e anon não', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const uuid = () => crypto.randomUUID();
  const admA = await db.createUser('a@nl.invalid', { name: 'Síndica A' });
  const admB = await db.createUser('b@nl.invalid', { name: 'Síndico B' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: slug, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(admA, 'nl-a', '11444777000161');
  const B = await prov(admB, 'nl-b', '11222333000181');
  const unit = async (T, block, label) => (await db.sql('insert into units (tenant_id, block, label) values ($1,$2,$3) returning id', [T, block, label]))[0].id;
  const a101 = await unit(A, 'A', '101'), a102 = await unit(A, 'A', '102');
  const invite = async (adm, T, email, role, u, name) => {
    const id = await db.createUser(email, { name });
    const inv = await db.rpc(adm, 'create_invitation', { p_tenant: T, p_email: email, p_role: role, p_unit: u, p_permissions: '{}' });
    await db.rpc(id, 'accept_invitation', { p_token: inv.token });
    return id;
  };
  const port = await invite(admA, A, 'p@nl.invalid', 'porteiro', null, 'Porteiro');
  const ana = await invite(admA, A, 'ana@nl.invalid', 'morador', a101, 'Ana Lima');
  await invite(admA, A, 'beto@nl.invalid', 'morador', a102, 'Beto Reis');
  await db.sql("update resident_contacts set phone = '11988887777' where user_id = $1", [ana]);
  const recv = (u) => db.rpc(port, 'receive_and_store', { p_tenant: A, p_idempotency_key: uuid(), p_unit: u, p_tracking: null, p_carrier: 'Correios',
    p_recipient: null, p_notes: null, p_storage_location: null, p_label_sha256: null, p_courier: 'Entregador', p_received_by_name: '' });
  await recv(a101); await recv(a102);

  // Worker conclui o e-mail da Ana como aceito pelo provedor e o WhatsApp como falha.
  const jobs = await db.sql(`select id, channel, recipient from notification_jobs where tenant_id=$1 and event='package_received'`, [A]);
  const email = jobs.find((j) => j.channel === 'email' && j.recipient === 'ana@nl.invalid');
  const wa = jobs.find((j) => j.channel === 'whatsapp');
  assert.ok(email && wa, 'avisos enfileirados');
  await db.service('select public.complete_notification_job($1,$2,$3,$4,$5)', [email.id, 'accepted', 'resend-123', null, false]);
  await db.service('select public.complete_notification_job($1,$2,$3,$4,$5)', [wa.id, 'failed', null, 'Número sem WhatsApp', true]);

  const log = (who, f = {}, T = A) => db.rpc(who, 'notification_log', { p_tenant: T, p_filters: f });
  const all = await log(admA);
  assert.ok(all.length >= 4);
  const e = all.find((x) => x.id === email.id);
  assert.equal(e.person, 'Ana Lima'); assert.equal(e.unit_label, '101'); assert.equal(e.carrier, 'Correios');
  assert.equal(e.provider_ref, 'resend-123'); assert.ok(e.sent_at, 'data do envio comprovada');
  assert.equal(all.find((x) => x.id === wa.id).last_error, 'Número sem WhatsApp');

  // Por unidade, morador, canal e situação.
  assert.ok((await log(admA, { unit: a102 })).every((x) => x.unit_id === a102));
  assert.ok((await log(admA, { search: 'ana' })).every((x) => x.person === 'Ana Lima'));
  assert.deepEqual((await log(admA, { channel: 'email', status: 'sent' })).map((x) => x.id), [email.id]);
  assert.deepEqual((await log(admA, { status: 'failed' })).map((x) => x.id), [wa.id]);
  assert.ok((await log(admA, { channel: 'push' })).every((x) => x.recipient === null), 'push não expõe id interno');

  // Paginação por cursor sem repetir linha.
  const p1 = await db.rpc(admA, 'notification_log', { p_tenant: A, p_filters: {}, p_limit: 2 });
  const p2 = await db.rpc(admA, 'notification_log', { p_tenant: A, p_filters: {}, p_limit: 2, p_cursor_at: p1[1].created_at, p_cursor_id: p1[1].id });
  assert.equal(new Set([...p1, ...p2].map((x) => x.id)).size, p1.length + p2.length);

  // Escopo.
  await assert.rejects(log(admB), /Somente quem aprova/);
  await assert.rejects(log(port), /Somente quem aprova/);
  await assert.rejects(log(ana), /Somente quem aprova/);
  assert.deepEqual(await log(admB, {}, B), []);
  await assert.rejects(log(admA, { x: '1' }), /Filtro inválido/);
  await assert.rejects(db.as(null, 'select public.notification_log($1)', [A]), /permission denied/);
  await db.raw.close();
});
