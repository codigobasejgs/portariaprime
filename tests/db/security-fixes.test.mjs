import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

async function setup() {
  const db = await createDb();
  await db.sql('update public.plans set published=true');
  db.setNow('2026-01-01T12:00:00Z');
  const admin = await db.createUser('admin@security.invalid');
  const tenant = (await db.rpc(admin, 'provision_tenant', {
    p_request_id: crypto.randomUUID(), p_name: 'Teste isolado', p_slug: 'teste-isolado',
    p_document: '12345678000190', p_timezone: 'America/Sao_Paulo', p_plan_code: 'profissional', p_cycle: 'monthly',
  })).tenant_id;
  const [{ id: unit }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'101') returning id", [tenant]);
  return { db, admin, tenant, unit };
}
const receive = (s, key) => s.db.rpc(s.admin, 'receive_package', {
  p_tenant: s.tenant, p_idempotency_key: key, p_unit: s.unit, p_tracking: key, p_carrier: 'Correios',
});
async function openOrder(s) {
  await s.db.service('select public.billing_tick()');
  return (await s.db.sql("select * from billing_orders where tenant_id=$1 and status='pending'", [s.tenant]))[0];
}
const pay = (s, order, tx) => s.db.service(
  "select public.apply_verified_payment($1,$2,'slug',$3,$3,1,'pix',null) r", [order.order_nsu, tx, order.amount_cents],
).then(rows => rows[0].r);

test('pedido cancelado/review nunca ativa em retries; wrappers internos sem EXECUTE', async () => {
  const s = await setup();
  try {
    s.db.setNow('2026-02-02T12:00:00Z');
    const order = await openOrder(s);
    await s.db.rpc(s.admin, 'cancel_subscription', { p_tenant: s.tenant });
    assert.equal((await pay(s, order, 'tx1')).result, 'review');
    assert.equal((await pay(s, order, 'tx1')).result, 'review');
    assert.equal((await s.db.sql('select * from payments')).length, 0);
    await assert.rejects(s.db.service("select public.apply_verified_payment_before_security_fix('a','b','c',1,1,1,'pix',null)"), /permission denied/);
  } finally { await s.db.raw.close(); }
});

test('plano pago futuro respeita início exclusivo do anterior sem scheduler', async () => {
  const s = await setup();
  try {
    s.db.setNow('2026-02-02T12:00:00Z');
    const first = await openOrder(s);
    assert.equal((await pay(s, first, 'tx-first')).result, 'activated');
    await s.db.rpc(s.admin, 'change_plan', { p_tenant: s.tenant, p_plan_code: 'essencial', p_cycle: 'monthly' });
    s.db.setNow('2026-02-24T12:00:00Z');
    const renewal = await openOrder(s);
    const paid = await pay(s, renewal, 'tx-renewal');
    assert.equal(paid.result, 'activated');
    assert.equal(new Date(paid.period_start).toISOString(), '2026-03-02T12:00:00.000Z');
    for (const now of ['2026-02-24T12:00:00Z', '2026-03-02T11:59:59Z']) {
      s.db.setNow(now);
      const overview = await s.db.rpc(s.admin, 'subscription_overview', { p_tenant: s.tenant });
      assert.equal(overview.plan.code, 'profissional');
      assert.equal(overview.entitlements.feature_ocr, true);
      assert.equal(overview.price_cents, 14900);
      assert.equal(overview.next_plan.code, 'essencial');
    }
    s.db.setNow('2026-03-02T12:00:00Z');
    const overview = await s.db.rpc(s.admin, 'subscription_overview', { p_tenant: s.tenant });
    assert.equal(overview.plan.code, 'essencial');
    assert.equal(overview.entitlements.feature_ocr, false);
    assert.equal(overview.price_cents, 9900);
    assert.equal((await s.db.as(s.admin, 'select app.has_feature($1,\'ocr\') allowed', [s.tenant]))[0].allowed, false);
  } finally { await s.db.raw.close(); }
});

test('revogação impede novos avisos e desautoriza fila anterior', async () => {
  const s = await setup();
  try {
    const resident = await s.db.createUser('resident@security.invalid');
    const invite = await s.db.rpc(s.admin, 'create_invitation', {
      p_tenant: s.tenant, p_email: 'resident@security.invalid', p_role: 'morador', p_unit: s.unit,
    });
    await s.db.rpc(resident, 'accept_invitation', { p_token: invite.token });
    await receive(s, 'before-revocation');
    const [job] = await s.db.sql("select id from notification_jobs where channel='email'");
    assert.equal((await s.db.service('select notification_is_authorized($1) ok', [job.id]))[0].ok, true);
    const [{id}] = await s.db.sql('select id from tenant_memberships where user_id=$1', [resident]);
    await s.db.rpc(s.admin, 'set_membership_status', { p_membership: id, p_status: 'revoked' });
    assert.equal((await s.db.service('select notification_is_authorized($1) ok', [job.id]))[0].ok, false);
    const pkg = await receive(s, 'after-revocation');
    assert.equal((await s.db.sql('select id from notification_jobs where ref_id=$1', [pkg.id])).length, 0);
  } finally { await s.db.raw.close(); }
});

test('totem pareado é recusado durante suspensão; reativação não recria dispositivo', async () => {
  const s = await setup();
  try {
    const device = await s.db.rpc(s.admin, 'create_device', { p_tenant: s.tenant, p_name: 'Totem' });
    await s.db.service("select device_pair($1,'testsecret')", [device.pairing_code]);
    await s.db.sql("update tenants set status='suspended' where id=$1", [s.tenant]);
    await assert.rejects(s.db.service("select device_context('testsecret')"), /indisponível/);
    await assert.rejects(s.db.service("select device_preregister('testsecret','key-suspend',null,'Outra','S1','Demo')"), /indisponível/);
    assert.equal((await s.db.sql('select id from packages')).length, 0);
    await s.db.sql("update tenants set status='active' where id=$1", [s.tenant]);
    assert.ok((await s.db.service("select device_context('testsecret') r"))[0].r.device_id);
  } finally { await s.db.raw.close(); }
});

test('PostgREST não pode registrar endpoint push arbitrário', async () => {
  const s = await setup();
  try {
    for (const url of ['https://127.0.0.1/push','https://localhost/push','https://fcm.googleapis.com.evil.test/push','https://fcm.googleapis.com:443/push','https://user@fcm.googleapis.com/push']) {
      await assert.rejects(s.db.as(s.admin, 'insert into push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth) values($1,$2,$3,\'x\',\'y\')', [s.tenant,s.admin,url]), /push_endpoint_allowlist/);
    }
    await s.db.as(s.admin, 'insert into push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth) values($1,$2,$3,\'x\',\'y\')', [s.tenant,s.admin,'https://fcm.googleapis.com/fcm/send/test']);
  } finally { await s.db.raw.close(); }
});
