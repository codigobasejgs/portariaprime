// Totem da equipe: correspondência do destinatário no servidor, guarda confirmada,
// última vaga, foto repetida, avisos para toda a unidade e entrega com provas.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

let db, T, admin, port, m1, m2, m3, other, u12b, u12c, u34, rackA, rackFull;
const uuid = () => crypto.randomUUID();
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message) || assert.fail(e.message));
const store = (path, owner) => db.service(`insert into storage.objects (bucket_id, name, owner) values ('tenant-private', $1, $2)`, [path, owner]);

async function resident(email, name, unit) {
  const id = await db.createUser(email, { name });
  const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: email, p_role: 'morador', p_unit: unit, p_permissions: '{}' });
  await db.rpc(id, 'accept_invitation', { p_token: inv.token });
  return id;
}
const receive = (extra = {}) => db.rpc(port, 'receive_and_store', {
  p_tenant: T, p_idempotency_key: uuid(), p_unit: u12b, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste',
  p_recipient: 'Jefferson Gomes dos Santos', p_notes: null, p_storage_location: rackA, p_label_sha256: null, ...extra,
});

before(async () => {
  db = await createDb();
  await db.sql(`update public.plans set published = true`);
  db.setNow('2026-10-22T12:00:00Z');
  admin = await db.createUser('sindico@totem.test');
  port = await db.createUser('porteiro@totem.test');
  T = (await db.rpc(admin, 'provision_tenant', { p_request_id: uuid(), p_name: 'Cond Totem', p_slug: 'cond-totem',
    p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
  [{ id: u12b }] = await db.as(admin, `insert into units (tenant_id, block, label) values ($1, 'A', '12B') returning id`, [T]);
  [{ id: u12c }] = await db.as(admin, `insert into units (tenant_id, block, label) values ($1, 'A', '12C') returning id`, [T]);
  [{ id: u34 }] = await db.as(admin, `insert into units (tenant_id, block, label) values ($1, 'B', '34') returning id`, [T]);
  const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: 'porteiro@totem.test', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
  await db.rpc(port, 'accept_invitation', { p_token: inv.token });
  m1 = await resident('jefferson@totem.test', 'Jefferson Gomes dos Santos', u12b);
  m2 = await resident('maria@totem.test', 'Maria Souza Santos', u12b);
  m3 = await resident('pedro@totem.test', 'Pedro Gomes', u12b);
  other = await resident('outro@totem.test', 'Jefferson Lima', u34);
  [{ id: rackA }] = await db.as(admin, `insert into storage_locations (tenant_id, concierge_location_id, code, rack, shelf, capacity)
    select $1, id, 'A-2', 'Estante A', 'Prateleira 2', 50 from concierge_locations where tenant_id = $1 returning id`, [T]);
  [{ id: rackFull }] = await db.as(admin, `insert into storage_locations (tenant_id, concierge_location_id, code, rack, shelf, capacity)
    select $1, id, 'B-1', 'Estante B', 'Prateleira 1', 1 from concierge_locations where tenant_id = $1 returning id`, [T]);
});

test('correspondência: nome + 12B confere; remetente/código de transportadora não casa; homônimo exige revisão', async () => {
  const ok = await db.rpc(port, 'match_recipient', { p_tenant: T, p_name: 'JEFFERSON GOMES DOS SANTOS', p_block: null, p_unit: 'Apto 12B' });
  assert.equal(ok.status, 'matched');
  assert.equal(ok.unit_id, u12b);
  // Código de triagem "RJ2-2"/"LSP-105" lido como unidade não aponta para nada.
  assert.equal((await db.rpc(port, 'match_recipient', { p_tenant: T, p_name: null, p_block: null, p_unit: 'LSP-105' })).status, 'not_found');
  // Nome de quem não mora na unidade lida: conflito explícito.
  const conflict = await db.rpc(port, 'match_recipient', { p_tenant: T, p_name: 'Jefferson Lima', p_block: 'A', p_unit: '12B' });
  assert.equal(conflict.status, 'conflict');
  // Só o primeiro nome: dois "Jefferson" em unidades diferentes, sem unidade lida → ambíguo.
  const homonym = await db.rpc(port, 'match_recipient', { p_tenant: T, p_name: 'Jefferson Santos Lima', p_block: null, p_unit: null });
  assert.notEqual(homonym.status, 'matched');
  // Remetente impresso no campo de nome não confere com a unidade: revisão humana.
  assert.equal((await db.rpc(port, 'match_recipient', { p_tenant: T, p_name: 'Fulano Remetente Ltda', p_block: null, p_unit: '12B' })).status, 'unit_only');
  // Morador não usa a busca (não enumera moradores).
  await rejects(db.rpc(m1, 'match_recipient', { p_tenant: T, p_name: 'Maria', p_block: null, p_unit: '12B' }), /Sem permissão/);
});

test('correspondência em endereço horizontal: quadra/lote e rua/casa com ou sem prefixo', async () => {
  const [{ id: lote }] = await db.as(admin, `insert into units (tenant_id, block, label) values ($1, 'Qd 3', 'Lote 15') returning id`, [T]);
  const [{ id: casa }] = await db.as(admin, `insert into units (tenant_id, block, label) values ($1, 'Rua 2', '7') returning id`, [T]);
  for (const [b, u, id] of [['Quadra 3', '15', lote], ['3', 'Lt 15', lote], ['QD3', 'LT15', lote], ['Rua 2', 'Casa 7', casa]]) {
    const r = await db.rpc(port, 'match_recipient', { p_tenant: T, p_name: null, p_block: b, p_unit: u });
    assert.equal(r.unit_id, id, `${b} / ${u}`);
  }
  assert.notEqual((await db.rpc(port, 'match_recipient', { p_tenant: T, p_name: null, p_block: 'Quadra 4', p_unit: '15' })).unit_id, lote, 'outra quadra não casa');
});

test('recebimento exige local confirmado; última vaga não é dada duas vezes; foto repetida recusada', async () => {
  await rejects(receive({ p_storage_location: null }), /Escolha o local/);
  const sha = 'a'.repeat(64);
  const first = await receive({ p_storage_location: rackFull, p_label_sha256: sha });
  assert.equal(first.storage_confirmed, true);
  assert.equal(first.storage_rack, 'Estante B');
  await rejects(receive({ p_storage_location: rackFull }), /lotado/);
  await rejects(receive({ p_label_sha256: sha }), /mesma foto/);
  const [p] = await db.sql(`select storage_confirmed_at from packages where id = $1`, [first.id]);
  assert.ok(p.storage_confirmed_at);
});

test('aviso de chegada vai para os 3 moradores da unidade, nunca para a outra unidade; retry não duplica', async () => {
  const key = uuid();
  const pkg = await receive({ p_idempotency_key: key, p_tracking: 'BR777' });
  await receive({ p_idempotency_key: key, p_tracking: 'BR777' });
  for (const u of [m1, m2, m3]) {
    const rows = await db.as(u, `select kind from notifications where package_id = $1`, [pkg.id]);
    assert.deepEqual(rows.map((r) => r.kind), ['package_received']);
  }
  assert.equal((await db.as(other, `select * from notifications where package_id = $1`, [pkg.id])).length, 0);
  const jobs = await db.sql(`select channel, recipient from notification_jobs where ref_id = $1 and event = 'package_received'`, [pkg.id]);
  assert.equal(jobs.filter((j) => j.channel === 'email').length, 3);
  assert.equal(jobs.filter((j) => j.channel === 'push').length, 3);
  assert.ok(!jobs.some((j) => j.recipient === 'outro@totem.test' || j.recipient === other));
});

test('entrega: consulta do QR não consome e mostra local atual; provas obrigatórias; retry idempotente; comprovante para a unidade', async () => {
  const pkg = await receive({ p_tracking: 'BR888' });
  await store(`${T}/packages/${pkg.id}/label_photo-lbl00001.jpg`, port);
  await db.rpc(port, 'attach_package_file', { p_tenant: T, p_package: pkg.id, p_kind: 'label_photo', p_path: `${T}/packages/${pkg.id}/label_photo-lbl00001.jpg` });
  const { token } = await db.rpc(m2, 'issue_pickup_token', { p_tenant: T, p_package: pkg.id });
  const seen = await db.rpc(port, 'lookup_pickup_token', { p_tenant: T, p_qr: token });
  const again = await db.rpc(port, 'lookup_pickup_token', { p_tenant: T, p_qr: token });
  assert.equal(again.id, pkg.id);
  assert.equal(seen.storage_shelf, 'Prateleira 2');
  assert.match(seen.label_photo_path, /label_photo-/);
  await rejects(db.rpc(port, 'lookup_pickup_token', { p_tenant: T, p_qr: 'LSP-105' }), /não é um QR/);

  const sig = `${T}/packages/${pkg.id}/signature-sig00001.png`;
  const photo = `${T}/packages/${pkg.id}/handover-pho00001.jpg`;
  await store(sig, port);
  const args = { p_tenant: T, p_package: pkg.id, p_request: uuid(), p_qr: token, p_picked_up_by: 'Maria Souza Santos',
    p_recipient_kind: 'morador', p_signature_path: sig, p_item_photo_path: photo, p_manual_reason: null };
  await rejects(db.rpc(port, 'deliver_package', args), /Foto do item/);
  // A falha não consumiu o QR.
  assert.equal((await db.rpc(port, 'lookup_pickup_token', { p_tenant: T, p_qr: token })).id, pkg.id);
  await store(photo, port);
  await rejects(db.rpc(port, 'deliver_package', { ...args, p_recipient_kind: 'vizinho' }), /recebedor autorizado/);
  const done = await db.rpc(port, 'deliver_package', args);
  assert.equal(done.status, 'RETIRADA');
  assert.match(done.protocol, /^PP-/);
  const retry = await db.rpc(port, 'deliver_package', args);
  assert.equal(retry.protocol, done.protocol);
  const [{ n }] = await db.sql(`select count(*)::int n from receipts where package_id = $1`, [pkg.id]);
  assert.equal(n, 1);

  for (const u of [m1, m2, m3]) {
    const [r] = await db.as(u, `select protocol, snapshot from receipts where package_id = $1`, [pkg.id]);
    assert.equal(r.protocol, done.protocol);
    assert.equal(r.snapshot.handover_path, photo);
    assert.equal(r.snapshot.recipient_kind, 'morador');
    assert.match(r.snapshot.storage, /Estante A › Prateleira 2/);
    assert.equal((await db.as(u, `select * from notifications where package_id = $1 and kind = 'package_picked_up'`, [pkg.id])).length, 1);
  }
  assert.equal((await db.as(other, `select * from receipts where package_id = $1`, [pkg.id])).length, 0);
  const picked = await db.sql(`select channel from notification_jobs where ref_id = $1 and event = 'package_picked_up'`, [pkg.id]);
  assert.equal(picked.length, 6);
});

test('morador revogado deixa de ser avisado e de ver comprovantes da unidade', async () => {
  const [m] = await db.sql(`select id from tenant_memberships where tenant_id = $1 and user_id = $2`, [T, m3]);
  await db.rpc(admin, 'set_membership_status', { p_membership: m.id, p_status: 'revoked' });
  const pkg = await receive({ p_tracking: 'BR999' });
  assert.equal((await db.sql(`select * from notifications where package_id = $1 and user_id = $2`, [pkg.id, m3])).length, 0);
  const jobs = await db.sql(`select recipient from notification_jobs where ref_id = $1`, [pkg.id]);
  assert.ok(!jobs.some((j) => j.recipient === 'pedro@totem.test' || j.recipient === m3));
  assert.equal((await db.as(m3, `select * from receipts`)).length, 0);
});
