// Migration 20261109000100: morador não identificado, recusa pelo morador e palavra-chave de entrega.
// Isolamento: entre unidades do mesmo condomínio e entre condomínios; anon sem acesso.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const uuid = () => crypto.randomUUID();
let db, A, B, admA, admB, port, ana, beto, carla, a101, a102, b101, loc;

before(async () => {
  db = await createDb();
  await db.sql('update plans set published = true');
  admA = await db.createUser('sindico-a@pm.invalid', { name: 'Síndica A' });
  admB = await db.createUser('sindico-b@pm.invalid', { name: 'Síndico B' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: slug, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  A = await prov(admA, 'pm-a', '11444777000161');
  B = await prov(admB, 'pm-b', '11222333000181');
  const unit = async (T, block, label) => (await db.sql('insert into units (tenant_id, block, label) values ($1,$2,$3) returning id', [T, block, label]))[0].id;
  a101 = await unit(A, 'A', '101'); a102 = await unit(A, 'A', '102'); b101 = await unit(B, 'A', '101');
  port = await invite(admA, A, 'port@pm.invalid', 'porteiro', null, 'Carlos Porteiro');
  ana = await invite(admA, A, 'ana@pm.invalid', 'morador', a101, 'Ana Lima');
  beto = await invite(admA, A, 'beto@pm.invalid', 'morador', a102, 'Beto Reis');
  carla = await invite(admB, B, 'carla@pm.invalid', 'morador', b101, 'Carla Dias');
  await db.sql("update resident_contacts set phone = '11988887777' where user_id = $1", [ana]);
  const [{ id: conc }] = await db.sql('select id from concierge_locations where tenant_id=$1', [A]);
  [{ id: loc }] = await db.sql("insert into storage_locations(tenant_id,concierge_location_id,code,rack,shelf,capacity) values($1,$2,'P1','E1','1',50) returning id", [A, conc]);
});
after(() => db?.raw.close());

async function invite(adm, T, email, role, u, name) {
  const uid = await db.createUser(email, { name });
  const inv = await db.rpc(adm, 'create_invitation', { p_tenant: T, p_email: email, p_role: role, p_unit: u, p_permissions: '{}' });
  await db.rpc(uid, 'accept_invitation', { p_token: inv.token });
  return uid;
}

const receive = (unit, recipient = 'Maria Souza') => db.rpc(port, 'receive_and_store', { p_tenant: A, p_idempotency_key: uuid(), p_unit: unit,
  p_tracking: null, p_carrier: 'Correios', p_recipient: recipient, p_notes: null, p_storage_location: loc, p_label_sha256: null,
  p_courier: 'João - Mercado Livre', p_received_by_name: 'Carlos Porteiro' });

test('grants: anon não executa nenhuma RPC nova; tabela sem escrita direta', async () => {
  const fns = ['unit_residents_for_staff(uuid,uuid)', 'package_mark_unidentified(uuid,uuid,text)', 'list_unidentified_packages(uuid)',
    'package_destinate(uuid,uuid,uuid,text,uuid)', 'resident_reject_package(uuid,uuid,text,text)', 'staff_package_flags(uuid)',
    'delivery_keyword_save(uuid,uuid,uuid,text,text,text,text,date)', 'delivery_keyword_cancel(uuid,uuid)',
    'delivery_keyword_save_v2(uuid,uuid,uuid,text,text,text,text,timestamptz)',
    'delivery_keyword_mark_used(uuid,uuid)', 'list_delivery_keywords(uuid,uuid)'];
  for (const f of fns) {
    const [r] = await db.sql(`select has_function_privilege('anon', 'public.${f}', 'execute') a, has_function_privilege('authenticated', 'public.${f}', 'execute') b`);
    assert.deepEqual([r.a, r.b], [false, true], f);
  }
  const [t] = await db.sql(`select has_table_privilege('anon','public.delivery_keywords','select') a,
    has_table_privilege('anon','public.delivery_keywords','truncate') b,
    has_table_privilege('authenticated','public.delivery_keywords','insert') c,
    has_table_privilege('authenticated','public.delivery_keywords','update') d,
    has_table_privilege('authenticated','public.delivery_keywords','delete') e,
    has_table_privilege('authenticated','public.delivery_keywords','truncate') f,
    has_function_privilege('authenticated','app.unit_people(uuid,uuid,boolean)','execute') g`);
  assert.deepEqual(Object.values(t), [false, false, false, false, false, false, false]);
  await assert.rejects(db.as(ana, "insert into delivery_keywords(tenant_id,unit_id,keyword) values($1,$2,'x1')", [A, a101]), /permission denied/);
});

test('(4) não identificado: moradores sem contato p/ portaria, marcação idempotente, aba e destinação', async () => {
  const people = await db.rpc(port, 'unit_residents_for_staff', { p_tenant: A, p_unit: a101 });
  assert.deepEqual(people, [{ name: 'Ana Lima', status: 'active' }], 'sem telefone/e-mail/user_id');
  await assert.rejects(db.rpc(ana, 'unit_residents_for_staff', { p_tenant: A, p_unit: a101 }), /Sem permissão/);
  await assert.rejects(db.rpc(admB, 'unit_residents_for_staff', { p_tenant: B, p_unit: a101 }), /Unidade inválida/);

  const pkg = await receive(a102, 'Fulano Desconhecido');
  await assert.rejects(db.rpc(port, 'package_mark_unidentified', { p_tenant: A, p_package: pkg.id, p_reason: 'xx' }), /Motivo inválido/);
  await assert.rejects(db.rpc(admB, 'package_mark_unidentified', { p_tenant: B, p_package: pkg.id, p_reason: 'unregistered_resident' }), /não encontrada/);
  const m1 = await db.rpc(port, 'package_mark_unidentified', { p_tenant: A, p_package: pkg.id, p_reason: 'unregistered_resident' });
  assert.equal(m1.unidentified_reason, 'unregistered_resident');
  await db.rpc(port, 'package_mark_unidentified', { p_tenant: A, p_package: pkg.id, p_reason: 'unregistered_resident' });
  const [{ n }] = await db.sql("select count(*)::int n from package_events where package_id=$1 and type='marked_unidentified'", [pkg.id]);
  assert.equal(n, 1, 'idempotente: um evento');

  // Aba do síndico: porteiro e síndico de outro condomínio não acessam; contatos só aqui.
  await assert.rejects(db.rpc(port, 'list_unidentified_packages', { p_tenant: A }), /Somente quem aprova/);
  await assert.rejects(db.rpc(admB, 'list_unidentified_packages', { p_tenant: A }), /Somente quem aprova/);
  const list = await db.rpc(admA, 'list_unidentified_packages', { p_tenant: A });
  assert.equal(list.length, 1);
  assert.equal(list[0].received_by_name, 'Carlos Porteiro');
  assert.equal(list[0].residents[0].name, 'Beto Reis');
  assert.equal(list[0].residents[0].email, 'beto@pm.invalid');
  assert.equal((await db.rpc(port, 'staff_package_flags', { p_tenant: A })).length, 1);

  // Destinar: morador de outra unidade é recusado; unidade de outro condomínio também.
  await assert.rejects(db.rpc(admA, 'package_destinate', { p_tenant: A, p_package: pkg.id, p_unit: a101, p_recipient: null, p_resident_user: beto }), /não está ativo/);
  await assert.rejects(db.rpc(admA, 'package_destinate', { p_tenant: A, p_package: pkg.id, p_unit: b101, p_recipient: 'X', p_resident_user: null }), /Unidade inválida/);
  await assert.rejects(db.rpc(port, 'package_destinate', { p_tenant: A, p_package: pkg.id, p_unit: a101, p_recipient: 'X', p_resident_user: null }), /Somente quem aprova/);
  const before = await db.sql("select count(*)::int n from notifications where package_id=$1 and user_id=$2", [pkg.id, ana]);
  assert.equal(before[0].n, 0);
  const d = await db.rpc(admA, 'package_destinate', { p_tenant: A, p_package: pkg.id, p_unit: a101, p_recipient: null, p_resident_user: ana });
  assert.equal(d.unit_id, a101); assert.equal(d.recipient_name, 'Ana Lima'); assert.equal(d.unidentified_reason, null);
  await db.rpc(admA, 'package_destinate', { p_tenant: A, p_package: pkg.id, p_unit: a101, p_recipient: null, p_resident_user: ana });
  const [{ n: notif }] = await db.sql("select count(*)::int n from notifications where package_id=$1 and user_id=$2 and kind='package_received'", [pkg.id, ana]);
  assert.equal(notif, 1, 'nova unidade avisada uma única vez');
  const [{ n: ev }] = await db.sql("select count(*)::int n from package_events where package_id=$1 and type='destinated'", [pkg.id]);
  assert.equal(ev, 2);
  const [{ n: au }] = await db.sql("select count(*)::int n from audit_logs where target_id=$1 and action='package.destinated'", [pkg.id]);
  assert.equal(au, 2);
  assert.equal((await db.rpc(admA, 'list_unidentified_packages', { p_tenant: A })).length, 0);
  // Continua retirável normalmente pela nova unidade.
  assert.match((await db.rpc(ana, 'issue_pickup_token', { p_tenant: A, p_package: pkg.id })).token, /^PP1\./);
});

test('(3a) recusa: só morador da unidade, idempotente, avisa equipe, derruba QR e portaria devolve', async () => {
  const pkg = await receive(a101, 'Ana Lima');
  const { token } = await db.rpc(ana, 'issue_pickup_token', { p_tenant: A, p_package: pkg.id });
  await assert.rejects(db.rpc(beto, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'wrong_unit' }), /sem acesso/);
  await assert.rejects(db.rpc(carla, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'wrong_unit' }), /sem acesso/);
  await assert.rejects(db.rpc(port, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'wrong_unit' }), /sem acesso/);
  await assert.rejects(db.rpc(ana, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'other', p_note: '' }), /Descreva/);
  await assert.rejects(db.rpc(ana, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'bad' }), /Motivo inválido/);
  const r = await db.rpc(ana, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'other', p_note: 'Não comprei isso' });
  assert.equal(r.rejection_reason, 'other'); assert.ok(r.rejected_at); assert.equal(r.status, 'ARMAZENADA', 'status não muda');
  const r2 = await db.rpc(ana, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'wrong_unit' });
  assert.equal(r2.rejection_reason, 'other', 'idempotente: mantém a primeira recusa');
  const [{ n: ev }] = await db.sql("select count(*)::int n from package_events where package_id=$1 and type='rejected_by_resident'", [pkg.id]);
  assert.equal(ev, 1);
  const staff = (await db.sql("select user_id from notifications where package_id=$1 and kind='package_rejected' order by user_id", [pkg.id])).map((x) => x.user_id);
  assert.deepEqual(staff.sort(), [admA, port].sort(), 'equipe (síndico + porteiro) avisada, morador não');
  // Push via outbox: só equipe deste condomínio, sem PII no payload; idempotente.
  const jobs = await db.sql("select id, recipient, payload from notification_jobs where event='package_rejected' and ref_id=$1", [pkg.id]);
  assert.deepEqual(jobs.map((j) => j.recipient).sort(), [admA, port].sort(), 'push só para a equipe');
  assert.ok(jobs.every((j) => JSON.stringify(j.payload) === '{}'), 'payload sem PIN/PII');
  for (const j of jobs) assert.equal((await db.sql('select notification_is_authorized($1) ok', [j.id]))[0].ok, true);
  for (const who of [ana, beto, admB, carla]) {
    const ins = await db.sql("insert into notification_jobs (tenant_id, event, channel, recipient, ref_id, payload) values ($1,'package_rejected','push',$2,$3,'{}') returning id", [A, who, pkg.id]);
    assert.equal(ins.length, 0, 'guard descarta destinatário fora da equipe');
  }
  const viaMail = await db.sql("insert into notification_jobs (tenant_id, event, channel, recipient, ref_id, payload) values ($1,'package_rejected','email','sindico-a@pm.invalid',$2,'{}') returning id", [A, pkg.id]);
  assert.equal(viaMail.length, 0, 'só canal push');

  await assert.rejects(db.rpc(port, 'lookup_pickup_token', { p_tenant: A, p_qr: token }), /substituído|recusada/);
  await assert.rejects(db.rpc(ana, 'issue_pickup_token', { p_tenant: A, p_package: pkg.id }), /recusada pelo morador/);
  await assert.rejects(db.rpc(port, 'issue_pickup_token', { p_tenant: A, p_package: pkg.id }), /recusada pelo morador/);
  const flags = await db.rpc(port, 'staff_package_flags', { p_tenant: A });
  assert.ok(flags.some((f) => f.id === pkg.id && f.rejection_reason === 'other' && f.rejection_note === 'Não comprei isso'));
  // Detalhe do morador mostra a recusa.
  const det = await db.rpc(ana, 'resident_package', { p_tenant: A, p_package: pkg.id });
  assert.equal((det.package ?? det).rejection_reason, 'other');
  // Entrega manual (sem QR) direto na RPC também é recusada no banco, antes de checar as provas.
  await assert.rejects(db.rpc(port, 'deliver_package', { p_tenant: A, p_package: pkg.id, p_request: uuid(), p_qr: null, p_picked_up_by: 'Ana Lima',
    p_recipient_kind: 'morador', p_signature_path: 'x/sig.png', p_item_photo_path: 'x/item.jpg', p_manual_reason: 'Morador sem celular, documento conferido' }), /recusada pelo morador/);
  const [still] = await db.sql('select status, picked_up_at from packages where id=$1', [pkg.id]);
  assert.deepEqual([still.status, still.picked_up_at], ['ARMAZENADA', null], 'continua guardada');

  const res = await db.rpc(port, 'resolve_package', { p_tenant: A, p_package: pkg.id, p_status: 'DEVOLVIDA', p_reason: 'Recusada pelo morador: não comprou' });
  assert.equal(res.status, 'DEVOLVIDA');
  assert.equal((await db.sql('select notification_is_authorized($1) ok', [jobs[0].id]))[0].ok, false, 'devolvida: push pendente deixa de valer');
  assert.equal((await db.rpc(ana, 'resident_reject_package', { p_tenant: A, p_package: pkg.id, p_reason: 'wrong_unit' })).status, 'DEVOLVIDA');
  const other = await receive(a101, 'Ana Lima');
  await db.rpc(port, 'resolve_package', { p_tenant: A, p_package: other.id, p_status: 'DEVOLVIDA', p_reason: 'Devolvida ao remetente' });
  await assert.rejects(db.rpc(ana, 'resident_reject_package', { p_tenant: A, p_package: other.id, p_reason: 'wrong_unit' }), /não está aguardando/);
  assert.equal((await db.rpc(port, 'staff_package_flags', { p_tenant: A })).some((f) => f.id === pkg.id), false);
  // Encomenda não recusada continua com QR normal.
  const ok = await receive(a101, 'Ana Lima');
  const t2 = await db.rpc(ana, 'issue_pickup_token', { p_tenant: A, p_package: ok.id });
  assert.equal((await db.rpc(port, 'lookup_pickup_token', { p_tenant: A, p_qr: t2.token })).id, ok.id);
});

test('(3b) palavra-chave: RLS entre unidades e condomínios, CRUD do morador, portaria marca utilizada', async () => {
  await assert.rejects(db.rpc(beto, 'delivery_keyword_save', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'girassol' }), /Somente moradores da unidade/);
  await assert.rejects(db.rpc(port, 'delivery_keyword_save', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'girassol' }), /Somente moradores da unidade/);
  await assert.rejects(db.rpc(carla, 'delivery_keyword_save', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'girassol' }), /Somente moradores da unidade/);
  await assert.rejects(db.rpc(ana, 'delivery_keyword_save', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'x' }), /2 a 60/);
  const k = await db.rpc(ana, 'delivery_keyword_save', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'girassol', p_carrier: 'iFood', p_recipient: 'Ana', p_note: null, p_valid_until: null });
  assert.equal(k.status, 'active'); assert.equal(k.created_by_name, 'Ana Lima'); assert.equal(k.unit_label, '101');
  const kc = await db.rpc(carla, 'delivery_keyword_save', { p_tenant: B, p_id: null, p_unit: b101, p_keyword: 'outro-cond' });

  // RLS direto na tabela.
  const sel = async (u) => (await db.as(u, 'select keyword from delivery_keywords order by keyword')).map((x) => x.keyword);
  assert.deepEqual(await sel(ana), ['girassol']);
  assert.deepEqual(await sel(beto), [], 'outro morador do mesmo condomínio NUNCA lê');
  assert.deepEqual(await sel(carla), ['outro-cond'], 'outro condomínio não lê A');
  assert.deepEqual(await sel(port), ['girassol'], 'equipe lê só o próprio condomínio');
  assert.deepEqual(await sel(admB), ['outro-cond']);
  await assert.rejects(db.as(null, 'select keyword from delivery_keywords'), /permission denied/);
  await assert.rejects(db.as(ana, "update delivery_keywords set keyword='hack' where id=$1", [k.id]), /permission denied/);

  // RPCs de leitura respeitam o mesmo recorte.
  assert.deepEqual((await db.rpc(beto, 'list_delivery_keywords', { p_tenant: A })).map((x) => x.keyword), []);
  assert.deepEqual((await db.rpc(port, 'list_delivery_keywords', { p_tenant: A, p_unit: a101 })).map((x) => x.keyword), ['girassol']);
  assert.deepEqual((await db.rpc(port, 'list_delivery_keywords', { p_tenant: A, p_unit: a102 })), []);
  await assert.rejects(db.rpc(carla, 'list_delivery_keywords', { p_tenant: A }), /Sem permissão/);
  // Edição/cancelamento só pela própria unidade (ou equipe para cancelar).
  await assert.rejects(db.rpc(beto, 'delivery_keyword_save', { p_tenant: A, p_id: k.id, p_unit: a102, p_keyword: 'hack' }), /não encontrada/);
  await assert.rejects(db.rpc(beto, 'delivery_keyword_cancel', { p_tenant: A, p_id: k.id }), /não encontrada/);
  await assert.rejects(db.rpc(admB, 'delivery_keyword_mark_used', { p_tenant: B, p_id: k.id }), /não encontrada/);
  const e = await db.rpc(ana, 'delivery_keyword_save', { p_tenant: A, p_id: k.id, p_unit: null, p_keyword: 'girassol azul', p_carrier: 'iFood' });
  assert.equal(e.keyword, 'girassol azul'); assert.equal(e.unit_id, a101, 'unidade não muda na edição');
  const used = await db.rpc(port, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k.id });
  assert.equal(used.status, 'used'); assert.equal(used.used_by, port);
  await db.rpc(port, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k.id });
  assert.deepEqual(await db.rpc(port, 'list_delivery_keywords', { p_tenant: A }), [], 'usada sai da lista da portaria');
  assert.equal((await db.rpc(ana, 'list_delivery_keywords', { p_tenant: A }))[0].status, 'used', 'morador vê o histórico');
  await assert.rejects(db.rpc(ana, 'delivery_keyword_save', { p_tenant: A, p_id: k.id, p_unit: null, p_keyword: 'nova' }), /utilizada ou cancelada/);
  const k2 = await db.rpc(ana, 'delivery_keyword_save', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'lua' });
  assert.equal((await db.rpc(ana, 'delivery_keyword_cancel', { p_tenant: A, p_id: k2.id })).status, 'cancelled');
  await assert.rejects(db.rpc(port, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k2.id }), /cancelada/);
  assert.equal(kc.tenant_id, B);
  // Autor também conclui a própria palavra-chave.
  const k3 = await db.rpc(ana, 'delivery_keyword_save', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'sol' });
  const u3 = await db.rpc(ana, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k3.id });
  assert.deepEqual([u3.status, u3.used_by], ['used', ana]);
});

test('(3b) palavra-chave: outro morador da MESMA unidade não lê, edita, cancela nem conclui', async () => {
  const dani = await invite(admA, A, 'dani@pm.invalid', 'morador', a101, 'Dani Lima');
  const k = await db.rpc(ana, 'delivery_keyword_save_v2', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'segredo-ana' });
  const kd = await db.rpc(dani, 'delivery_keyword_save_v2', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'segredo-dani' });
  const mine = async (u) => (await db.as(u, "select keyword from delivery_keywords where keyword like 'segredo-%' order by keyword")).map((x) => x.keyword);
  assert.deepEqual(await mine(ana), ['segredo-ana']);
  assert.deepEqual(await mine(dani), ['segredo-dani'], 'RLS: só as próprias');
  assert.deepEqual(await mine(port), ['segredo-ana', 'segredo-dani']);
  const listed = (await db.rpc(dani, 'list_delivery_keywords', { p_tenant: A })).map((x) => x.keyword);
  assert.ok(listed.includes('segredo-dani') && !listed.includes('segredo-ana'));
  assert.equal((await db.rpc(dani, 'list_delivery_keywords', { p_tenant: A, p_unit: a101 })).some((x) => x.id === k.id), false);
  await assert.rejects(db.rpc(dani, 'delivery_keyword_save', { p_tenant: A, p_id: k.id, p_unit: null, p_keyword: 'hack' }), /não encontrada/);
  await assert.rejects(db.rpc(dani, 'delivery_keyword_save_v2', { p_tenant: A, p_id: k.id, p_unit: null, p_keyword: 'hack' }), /não encontrada/);
  await assert.rejects(db.rpc(dani, 'delivery_keyword_cancel', { p_tenant: A, p_id: k.id }), /não encontrada/);
  await assert.rejects(db.rpc(dani, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k.id }), /não encontrada/);
  const [row] = await db.sql('select keyword, status from delivery_keywords where id=$1', [k.id]);
  assert.deepEqual([row.keyword, row.status], ['segredo-ana', 'active'], 'intacta');
  // Ex-morador perde acesso à própria palavra-chave.
  await db.sql("update unit_memberships set status='revoked' where user_id=$1", [dani]);
  await assert.rejects(db.rpc(dani, 'delivery_keyword_cancel', { p_tenant: A, p_id: kd.id }), /não encontrada|Sem permissão/);
  await db.sql("update unit_memberships set status='active' where user_id=$1", [dani]);
});

test('(3b) palavra-chave: validade com hora exata (expires_at)', async () => {
  db.setNow('2026-11-09T12:00:00Z');
  try {
    await assert.rejects(db.rpc(ana, 'delivery_keyword_save_v2', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'velha', p_expires_at: '2026-11-09T11:59:59Z' }), /futuro/);
    await assert.rejects(db.rpc(ana, 'delivery_keyword_save_v2', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'agora', p_expires_at: '2026-11-09T12:00:00Z' }), /futuro/);
    await assert.rejects(db.rpc(ana, 'delivery_keyword_save_v2', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'inf', p_expires_at: 'infinity' }), /futuro/);
    // "hoje até 18h" em São Paulo = 21:00Z.
    const k = await db.rpc(ana, 'delivery_keyword_save_v2', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'até-18h', p_expires_at: '2026-11-09T18:00:00-03:00' });
    assert.equal(new Date(k.expires_at).toISOString(), '2026-11-09T21:00:00.000Z');
    const k2 = await db.rpc(ana, 'delivery_keyword_save_v2', { p_tenant: A, p_id: null, p_unit: a101, p_keyword: 'até-18h-b', p_expires_at: '2026-11-09T21:00:00Z' });
    const staffSees = async (id) => (await db.rpc(port, 'list_delivery_keywords', { p_tenant: A, p_unit: a101 })).some((x) => x.id === id);

    db.setNow('2026-11-09T20:59:59Z');
    assert.equal(await staffSees(k.id), true, '1s antes: visível');
    assert.equal((await db.rpc(port, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k.id })).status, 'used');

    db.setNow('2026-11-09T21:00:00Z');
    assert.equal(await staffSees(k2.id), false, 'no instante exato: some da portaria');
    await assert.rejects(db.rpc(port, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k2.id }), /expirada/);
    await assert.rejects(db.rpc(ana, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k2.id }), /expirada/);
    assert.equal((await db.rpc(port, 'delivery_keyword_mark_used', { p_tenant: A, p_id: k.id })).status, 'used', 'já usada: idempotente');
    assert.equal((await db.rpc(ana, 'list_delivery_keywords', { p_tenant: A })).some((x) => x.id === k2.id), false);
    // Edição pode renovar a validade.
    const r = await db.rpc(ana, 'delivery_keyword_save_v2', { p_tenant: A, p_id: k2.id, p_unit: null, p_keyword: 'até-18h-b', p_expires_at: '2026-11-10T21:00:00Z' });
    assert.equal(new Date(r.expires_at).toISOString(), '2026-11-10T21:00:00.000Z');
    assert.equal(await staffSees(k2.id), true);
  } finally { db.setNow(null); }
});
