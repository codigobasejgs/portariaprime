import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

let db, tenant, admin, resident, unit, otherUnit, device, concierge, location;
const hash = 'd'.repeat(64);
const uuid = () => crypto.randomUUID();
const receive = (key = uuid(), tracking = null, unitId = unit, secret = hash) => db.service(
  'select public.device_receive($1,$2,$3,$4,$5,$6) r', [secret, key, unitId, 'Correios', tracking, 'Entregador teste']).then(r => r[0].r);

before(async () => {
  db = await createDb();
  await db.sql('update plans set published=true');
  admin = await db.createUser('admin@device.invalid');
  resident = await db.createUser('resident@device.invalid');
  const provision = async (slug, doc) => (await db.rpc(admin, 'provision_tenant', {
    p_request_id: uuid(), p_name: slug, p_slug: slug, p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly',
  })).tenant_id;
  tenant = await provision('device-auto', '11444777000161');
  const otherTenant = await provision('device-other', '11222333000181');
  [{ id: unit }] = await db.as(admin, "insert into units(tenant_id,block,label) values($1,'12B','23') returning id", [tenant]);
  [{ id: otherUnit }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'23') returning id", [otherTenant]);
  [{ id: concierge }] = await db.sql('select id from concierge_locations where tenant_id=$1', [tenant]);
  [{ id: location }] = await db.as(admin, `insert into storage_locations(tenant_id,concierge_location_id,code,rack,shelf,capacity)
    values($1,$2,'A1','Estante A','Prateleira 1',10) returning id`, [tenant, concierge]);
  [{ id: device }] = await db.sql("insert into device_enrollments(tenant_id,name,status,secret_hash,concierge_location_id) values($1,'Tablet','active',$2,$3) returning id", [tenant, hash, concierge]);
  const inv = await db.rpc(admin, 'create_invitation', { p_tenant: tenant, p_email: 'resident@device.invalid', p_role: 'morador', p_unit: unit, p_permissions: '{}' });
  await db.rpc(resident, 'accept_invitation', { p_token: inv.token });
  await db.sql("update resident_contacts set phone='+5511999999999' where tenant_id=$1", [tenant]);
});
after(async () => { await db?.raw.close(); });

test('totem recebe diretamente, fica visível ao morador e gera avisos sem conferência', async () => {
  const key = uuid();
  const r = await receive(key, 'AUTO123');
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'replayed', 'storage_code', 'storage_rack', 'storage_shelf', 'concierge_name'].sort());
  assert.equal(r.replayed, false);
  assert.equal(r.storage_rack, 'Estante A');
  const [p] = await db.as(resident, 'select * from packages where idempotency_key=$1', [key]);
  assert.equal(p.status, 'ARMAZENADA');
  assert.equal(p.registered_via, 'totem');
  assert.equal(p.received_device_id, device);
  assert.equal(p.received_by, null);
  assert.ok(p.received_at && p.stored_at);
  assert.equal(p.storage_confirmed_at, null, 'não inventa confirmação física do operador');
  const notifications = await db.as(resident, 'select * from notifications where package_id=$1', [p.id]);
  assert.equal(notifications.length, 1);
  const jobs = await db.sql('select channel from notification_jobs where ref_id=$1', [p.id]);
  assert.deepEqual(jobs.map(j => j.channel).sort(), ['email', 'push', 'whatsapp']);
  const [event] = await db.sql("select actor_id,data from package_events where package_id=$1 and type='received'", [p.id]);
  assert.equal(event.actor_id, null); assert.equal(event.data.device_id, device);
  assert.equal((await db.sql("select * from audit_logs where target_id=$1 and action='device.package_received'", [p.id])).length, 1);
  assert.equal((await receive(key, 'AUTO123')).replayed, true);
  assert.equal((await db.sql('select * from notification_jobs where ref_id=$1', [p.id])).length, 3);
  await assert.rejects(receive(key, 'ALTERADO'), /Identificador/);
  await assert.rejects(receive(uuid(), 'auto123'), /rastreio já registrado/);
});

test('credencial, isolamento, grants, suspensão e revogação são obrigatórios', async () => {
  await assert.rejects(receive(uuid(), null, unit, 'f'.repeat(64)), /revogado/);
  await assert.rejects(receive(uuid(), null, otherUnit), /Unidade inválida/);
  await assert.rejects(receive(uuid(), null, null), /Unidade inválida/);
  await assert.rejects(receive('curta'), /inválidos/);
  const args = { p_secret_hash: hash, p_idempotency_key: uuid(), p_unit: unit, p_carrier: 'Correios', p_tracking: null, p_courier: null };
  await assert.rejects(db.rpc(null, 'device_receive', args), /permission denied/);
  await assert.rejects(db.rpc(admin, 'device_receive', args), /permission denied/);
  await db.sql("update tenants set status='suspended' where id=$1", [tenant]);
  await assert.rejects(receive(), /indisponível/);
  await db.sql("update tenants set status='active' where id=$1", [tenant]);
  await db.sql("update device_enrollments set status='revoked' where id=$1", [device]);
  await assert.rejects(receive(), /revogado/);
  await db.sql("update device_enrollments set status='active' where id=$1", [device]);
});

test('última vaga e local ausente não produzem recebimento nem avisos parciais', async () => {
  await db.sql('update storage_locations set capacity=2 where id=$1', [location]);
  await receive(); // primeira encomenda já usa a outra vaga
  const key = uuid();
  await assert.rejects(receive(key), /lotados/);
  assert.equal((await db.sql('select * from packages where idempotency_key=$1', [key])).length, 0);
  await db.sql('update storage_locations set active=false where id=$1', [location]);
  await assert.rejects(receive(key), /local de guarda ativo/);
  await db.sql('update storage_locations set active=true,capacity=10 where id=$1', [location]);
});

test('chave de outro dispositivo ou funcionário nunca devolve registro alheio', async () => {
  const otherHash = 'e'.repeat(64);
  await db.sql("insert into device_enrollments(tenant_id,name,status,secret_hash) values($1,'Segundo','active',$2)", [tenant, otherHash]);
  const key = uuid();
  await receive(key);
  await assert.rejects(receive(key, null, unit, otherHash), /Identificador/);
  const staffKey = uuid();
  await db.rpc(admin, 'receive_package', { p_tenant: tenant, p_idempotency_key: staffKey, p_unit: unit, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste' });
  await assert.rejects(receive(staffKey), /Identificador/);
  // Sem portaria explícita, o dispositivo utiliza a portaria padrão do próprio condomínio.
  assert.equal((await receive(uuid(), null, unit, otherHash)).storage_code, 'A1');
});
