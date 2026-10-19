// Testes de banco: migrations, RLS entre condomínios, papéis, encomendas,
// retirada concorrente, trial de 1 mês e cobrança. Rodam como usuário comum
// (papel authenticated + JWT sub), sem service role, salvo quando indicado.
// Uso: node --test tests/db/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

let db, A, B, adminA, adminB, portA, morA, morB, outsider, unitA, unitB;
const uuid = () => crypto.randomUUID();

async function provision(uid, slug, doc, extra = {}) {
  return db.rpc(uid, 'provision_tenant', {
    p_request_id: extra.req || uuid(), p_name: 'Cond ' + slug, p_slug: slug, p_document: doc,
    p_timezone: extra.tz || 'America/Sao_Paulo', p_plan_code: extra.plan || 'profissional', p_cycle: extra.cycle || 'monthly',
  });
}
async function invite(adminUid, tenant, email, role, unit = null) {
  return db.rpc(adminUid, 'create_invitation', { p_tenant: tenant, p_email: email, p_role: role, p_unit: unit, p_permissions: '{}' });
}
async function storeObject(path) {
  await db.service(`insert into storage.objects (bucket_id, name) values ('tenant-private', $1)`, [path]);
}
const rejects = (p, re) => assert.rejects(p, (e) => (re ? re.test(e.message) : true) || assert.fail(e.message));

before(async () => {
  db = await createDb();
  await db.sql(`update public.plans set published = true`);
  db.setNow('2026-01-31T15:00:00Z');
  adminA = await db.createUser('admin@a.test');
  adminB = await db.createUser('admin@b.test');
  portA = await db.createUser('porteiro@a.test');
  morA = await db.createUser('morador@a.test');
  morB = await db.createUser('morador@b.test');
  outsider = await db.createUser('curioso@x.test');
  A = (await provision(adminA, 'cond-a', '11222333000181')).tenant_id;
  B = (await provision(adminB, 'cond-b', '44555666000172')).tenant_id;
  // Mesmo bloco/unidade nos dois condomínios.
  [{ id: unitA }] = await db.as(adminA, `insert into public.units (tenant_id, block, label) values ($1,'A','101') returning id`, [A]);
  [{ id: unitB }] = await db.as(adminB, `insert into public.units (tenant_id, block, label) values ($1,'A','101') returning id`, [B]);
  const ip = await invite(adminA, A, 'porteiro@a.test', 'porteiro');
  await db.rpc(portA, 'accept_invitation', { p_token: ip.token });
  const ima = await invite(adminA, A, 'morador@a.test', 'morador', unitA);
  await db.rpc(morA, 'accept_invitation', { p_token: ima.token });
  const imb = await invite(adminB, B, 'morador@b.test', 'morador', unitB);
  await db.rpc(morB, 'accept_invitation', { p_token: imb.token });
  await db.as(adminA, `insert into public.storage_locations (tenant_id, concierge_location_id, code, capacity)
    select $1, id, 'A1', 1 from public.concierge_locations where tenant_id = $1`, [A]);
});

test('trial de 1 mês de calendário: 31/01 termina no último dia de fevereiro, mesmo horário local', async () => {
  const [s] = await db.sql(`select trial_started_at, trial_ends_at, status from public.subscriptions where tenant_id = $1`, [A]);
  assert.equal(s.status, 'trialing');
  assert.equal(new Date(s.trial_ends_at).toISOString(), '2026-02-28T15:00:00.000Z');
});

test('provisionamento idempotente e trial não se repete para o mesmo documento', async () => {
  const req = uuid();
  const u = await db.createUser('dup@x.test');
  const r1 = await provision(u, 'cond-dup', '99888777000166', { req });
  const r2 = await provision(u, 'cond-dup', '99888777000166', { req });
  assert.equal(r1.tenant_id, r2.tenant_id);
  assert.equal(r2.replayed, true);
  await rejects(provision(u, 'cond-dup-2', '99.888.777/0001-66'), /já utilizou o mês gratuito/);
  // Mesma pessoa pode administrar outro condomínio (documento diferente).
  const r3 = await provision(u, 'cond-outro', '12345678000190');
  assert.ok(r3.tenant_id);
});

test('cadastro sem e-mail verificado não provisiona', async () => {
  const u = await db.createUser('naoverificado@x.test', { verified: false });
  await rejects(provision(u, 'cond-nv', '55444333000122'), /Confirme seu e-mail/);
});

test('isolamento: usuário de A não lê nem grava dados de B (tabelas, RPC, storage)', async () => {
  const unitsSeenByA = await db.as(adminA, `select id from public.units`);
  assert.ok(unitsSeenByA.every((u) => u.id !== unitB));
  assert.equal((await db.as(adminA, `select * from public.tenants where id = $1`, [B])).length, 0);
  assert.equal((await db.as(adminA, `select * from public.subscriptions where tenant_id = $1`, [B])).length, 0);
  await rejects(db.as(adminA, `insert into public.units (tenant_id, label) values ($1, 'X')`, [B]), /row-level security/);
  const upd = await db.as(adminA, `update public.units set label = 'hack' where id = $1 returning id`, [unitB]);
  assert.equal(upd.length, 0);
  await rejects(db.rpc(adminA, 'receive_package', { p_tenant: B, p_idempotency_key: 'x-key-0001', p_unit: unitB,
    p_tracking: 'T1', p_carrier: 'Correios' }), /Sem permissão/);
  // Encomenda de A não pode apontar para unidade de B (FK composta).
  await rejects(db.rpc(adminA, 'receive_package', { p_tenant: A, p_idempotency_key: 'x-key-0002', p_unit: unitB,
    p_tracking: 'T1', p_carrier: 'Correios' }), /Unidade inválida/);
  await rejects(db.service(`insert into public.packages (tenant_id, unit_id, status, idempotency_key) values ($1, $2, 'RECEBIDA', 'svc-cross-1')`, [A, unitB]), /foreign key/);
  const [{ n }] = await db.sql(`select count(*)::int n from public.packages where tenant_id = $1`, [B]);
  assert.equal(n, 0);
});

test('mesmo rastreio em condomínios diferentes não colide; duplicado ativo no mesmo condomínio é recusado', async () => {
  await db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-a-0001', p_unit: unitA, p_tracking: 'BR123', p_carrier: 'Correios' });
  await db.rpc(adminB, 'receive_package', { p_tenant: B, p_idempotency_key: 'rk-b-0001', p_unit: unitB, p_tracking: 'BR123', p_carrier: 'Correios' });
  await rejects(db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-a-0002', p_unit: unitA, p_tracking: 'br123', p_carrier: 'Correios' }), /Já existe uma encomenda pendente/);
});

test('lotação: local cheio não recebe e não há fallback silencioso', async () => {
  // A1 tem capacidade 1 e já recebeu BR123; a próxima precisa de outro local.
  await rejects(db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-a-full', p_unit: unitA, p_tracking: 'FULL1', p_carrier: 'Loggi' }), /lotados/);
  const [{ n }] = await db.sql(`select count(*)::int n from public.packages p join public.storage_locations s on s.id = p.storage_location_id
    where s.code = 'A1' and p.tenant_id = $1 and p.status in ('RECEBIDA','ARMAZENADA')`, [A]);
  assert.equal(n, 1);
  await db.as(adminA, `insert into public.storage_locations (tenant_id, concierge_location_id, code, capacity, is_contingency)
    select $1, id, 'CONT', 50, true from public.concierge_locations where tenant_id = $1`, [A]);
});

test('retry com a mesma chave de idempotência não duplica a encomenda', async () => {
  const a = await db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-a-idem', p_unit: unitA, p_tracking: 'IDEM1', p_carrier: 'Loggi' });
  const b = await db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-a-idem', p_unit: unitA, p_tracking: 'IDEM1', p_carrier: 'Loggi' });
  assert.equal(a.id, b.id);
  assert.equal(b.replayed, true);
});

test('outbox: recebimento gera aviso interno ao morador; destinatário vem do banco', async () => {
  const notifs = await db.as(morA, `select title from public.notifications`);
  assert.ok(notifs.length >= 1);
  const jobs = await db.sql(`select channel, recipient from public.notification_jobs where tenant_id = $1 and event = 'package_received'`, [A]);
  assert.ok(jobs.some((j) => j.channel === 'email' && j.recipient === 'morador@a.test'));
  assert.equal((await db.as(morB, `select * from public.notifications where tenant_id = $1`, [A])).length, 0);
});

test('morador vê apenas encomendas da própria unidade e não se promove', async () => {
  const pk = await db.as(morA, `select tenant_id from public.packages`);
  assert.ok(pk.length > 0 && pk.every((p) => p.tenant_id === A));
  assert.equal((await db.as(morB, `select * from public.packages where tenant_id = $1`, [A])).length, 0);
  await rejects(db.as(morA, `update public.tenant_memberships set role = 'admin' where user_id = $1`, [morA]), /permission denied/);
  await rejects(db.as(morA, `insert into public.unit_memberships (tenant_id, unit_id, user_id) values ($1, $2, $3)`, [B, unitB, morA]), /permission denied/);
  await rejects(db.as(morA, `insert into public.platform_admins (user_id) values ($1)`, [morA]), /permission denied/);
  await rejects(db.rpc(morA, 'receive_package', { p_tenant: A, p_idempotency_key: 'mor-try-01', p_unit: unitA, p_tracking: 'M', p_carrier: 'x' }), /Sem permissão/);
});

test('convite: e-mail errado, reutilizado e expirado são recusados', async () => {
  const inv = await invite(adminA, A, 'novo@a.test', 'morador', unitA);
  await rejects(db.rpc(outsider, 'accept_invitation', { p_token: inv.token }), /outro e-mail/);
  const novo = await db.createUser('novo@a.test');
  await db.rpc(novo, 'accept_invitation', { p_token: inv.token });
  await rejects(db.rpc(novo, 'accept_invitation', { p_token: inv.token }), /já foi utilizado/);
  const inv2 = await invite(adminA, A, 'tarde@a.test', 'porteiro');
  const tarde = await db.createUser('tarde@a.test');
  db.setNow('2026-02-10T15:00:00Z');
  await rejects(db.rpc(tarde, 'accept_invitation', { p_token: inv2.token }), /expirado/);
  db.setNow('2026-01-31T15:00:00Z');
  // Porteiro não pode convidar.
  await rejects(invite(portA, A, 'x@a.test', 'porteiro'), /Sem permissão/);
});

test('revogação vale imediatamente, mesmo com JWT válido', async () => {
  const u = await db.createUser('temp@a.test');
  const inv = await invite(adminA, A, 'temp@a.test', 'porteiro');
  await db.rpc(u, 'accept_invitation', { p_token: inv.token });
  assert.ok((await db.as(u, `select * from public.units where tenant_id = $1`, [A])).length > 0);
  const [m] = await db.sql(`select id from public.tenant_memberships where user_id = $1`, [u]);
  await db.rpc(adminA, 'set_membership_status', { p_membership: m.id, p_status: 'revoked' });
  assert.equal((await db.as(u, `select * from public.units where tenant_id = $1`, [A])).length, 0);
});

test('QR de uso único: retirada concorrente, QR reutilizado/estrangeiro/vazio', async () => {
  const pkg = await db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-qr-0001', p_unit: unitA, p_tracking: 'QR1', p_carrier: 'Amazon' });
  const { token } = await db.rpc(morA, 'issue_pickup_token', { p_tenant: A, p_package: pkg.id });
  assert.match(token, /^PP1\./);
  // Morador de B não emite QR de encomenda de A.
  await rejects(db.rpc(morB, 'issue_pickup_token', { p_tenant: A, p_package: pkg.id }), /Sem permissão/);
  // QR de A lido em B.
  await rejects(db.rpc(adminB, 'lookup_pickup_token', { p_tenant: B, p_qr: token }), /não reconhecido/);
  const sig = `${A}/packages/${pkg.id}/signature-abcdef12.png`;
  await storeObject(sig);
  const args = { p_tenant: A, p_package: pkg.id, p_method: 'qr', p_qr: token, p_picked_up_by: 'Morador A', p_signature_path: sig, p_handover_path: null, p_manual_reason: null };
  // Token vazio não faz bypass.
  await rejects(db.rpc(portA, 'confirm_pickup', { ...args, p_qr: '' }), /não corresponde/);
  // PGlite tem uma única conexão: a disputa real entre conexões é garantida por
  // SELECT ... FOR UPDATE + checagem de status na RPC. Aqui validamos a regra:
  // a segunda confirmação (outro porteiro, mesmo QR) é recusada.
  const first = await db.rpc(portA, 'confirm_pickup', args);
  assert.equal(first.status, 'RETIRADA');
  await rejects(db.rpc(adminA, 'confirm_pickup', args), /já foi retirada/);
  await rejects(db.rpc(adminA, 'lookup_pickup_token', { p_tenant: A, p_qr: token }), /já utilizado/);
  const [r] = await db.sql(`select count(*)::int n from public.receipts where package_id = $1`, [pkg.id]);
  assert.equal(r.n, 1);
});

test('QR expirado é recusado; manual exige justificativa e assinatura enviada', async () => {
  const pkg = await db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-qr-0002', p_unit: unitA, p_tracking: 'QR2', p_carrier: 'Amazon' });
  const { token } = await db.rpc(morA, 'issue_pickup_token', { p_tenant: A, p_package: pkg.id });
  db.setNow('2026-02-05T15:00:00Z');
  await rejects(db.rpc(portA, 'lookup_pickup_token', { p_tenant: A, p_qr: token }), /expirado/);
  const base = { p_tenant: A, p_package: pkg.id, p_method: 'manual', p_qr: null, p_picked_up_by: 'Fulano', p_handover_path: null };
  await rejects(db.rpc(portA, 'confirm_pickup', { ...base, p_signature_path: `${A}/packages/${pkg.id}/signature-zzzzzzzz.png`, p_manual_reason: 'curto' }), /justificativa/);
  await rejects(db.rpc(portA, 'confirm_pickup', { ...base, p_signature_path: `${A}/packages/${pkg.id}/signature-zzzzzzzz.png`, p_manual_reason: 'Morador sem celular no momento' }), /Assinatura não recebida/);
  db.setNow('2026-01-31T15:00:00Z');
});

test('ocupação/pendências: exceções não contam como pendentes', async () => {
  const pkg = await db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-exc-001', p_unit: unitA, p_tracking: 'EXC1', p_carrier: 'Outra' });
  await rejects(db.rpc(portA, 'resolve_package', { p_tenant: A, p_package: pkg.id, p_status: 'EXTRAVIADA', p_reason: 'sumiu da estante X' }), /Somente o administrador/);
  await db.rpc(portA, 'resolve_package', { p_tenant: A, p_package: pkg.id, p_status: 'DEVOLVIDA', p_reason: 'Endereço incorreto, devolvido' });
  const rows = await db.as(portA, `select * from public.list_packages($1, 'PENDENTES')`, [A]);
  assert.ok(!rows.some((r) => r.id === pkg.id));
  const sum = await db.rpc(portA, 'report_summary', { p_tenant: A, p_from: '2026-01-01', p_to: '2026-02-28' });
  const [{ n }] = await db.sql(`select count(*)::int n from public.packages where tenant_id = $1 and status in ('RECEBIDA','ARMAZENADA')`, [A]);
  assert.equal(sum.pending_now, n);
});

test('cobrança: sem checkout durante o teste; job cria exatamente 1 pedido na expiração', async () => {
  await rejects(db.rpc(adminA, 'prepare_checkout', { p_tenant: A }), /mês grátis vai até/);
  db.setNow('2026-02-25T15:00:00Z');
  await db.service(`select public.billing_tick()`);
  const [rem] = await db.sql(`select reminders_sent from public.subscriptions where tenant_id = $1`, [A]);
  assert.deepEqual(rem.reminders_sent, ['trial_d3']);
  db.setNow('2026-02-28T15:00:00Z');
  await Promise.all([db.service(`select public.billing_tick()`), db.service(`select public.billing_tick()`)]);
  await db.service(`select public.billing_tick()`);
  const orders = await db.sql(`select * from public.billing_orders where tenant_id = $1`, [A]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].amount_cents, 14900);
  const [s] = await db.sql(`select status from public.subscriptions where tenant_id = $1`, [A]);
  assert.equal(s.status, 'pending_payment');
  // Porteiro não acessa faturamento.
  await rejects(db.rpc(portA, 'prepare_checkout', { p_tenant: A }), /faturamento/);
  assert.equal((await db.as(portA, `select * from public.billing_orders`)).length, 0);
});

test('carência e restrição comercial: bloqueia recebimento, mantém retirada', async () => {
  const pkg = await db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-grace-1', p_unit: unitA, p_tracking: 'GR1', p_carrier: 'Outra' });
  db.setNow('2026-03-08T16:00:00Z'); // fim do teste + 7 dias + 1h
  const [st] = await db.as(adminA, `select app.commercial_state($1) s`, [A]);
  assert.equal(st.s, 'restricted');
  await rejects(db.rpc(portA, 'receive_package', { p_tenant: A, p_idempotency_key: 'rk-grace-2', p_unit: unitA, p_tracking: 'GR2', p_carrier: 'Outra' }), /Assinatura inativa/);
  const sig = `${A}/packages/${pkg.id}/signature-grace001.png`;
  await storeObject(sig);
  const done = await db.rpc(portA, 'confirm_pickup', { p_tenant: A, p_package: pkg.id, p_method: 'manual', p_qr: null,
    p_picked_up_by: 'Morador A', p_signature_path: sig, p_handover_path: null, p_manual_reason: 'Morador retirou com documento' });
  assert.equal(done.status, 'RETIRADA');
});

test('pagamento: valor menor vai para revisão; verificado ativa período por calendário; duplicado não estende', async () => {
  const [o] = await db.sql(`select * from public.billing_orders where tenant_id = $1 and status = 'pending'`, [A]);
  // Usuário comum não consegue aplicar pagamento.
  await rejects(db.as(adminA, `select public.apply_verified_payment($1,'t','s',14900,14900,1,'pix','')`, [o.order_nsu]), /permission denied/);
  const low = await db.service(`select public.apply_verified_payment($1,'tx-low','s',100,100,1,'pix','') r`, [o.order_nsu]);
  assert.equal(low[0].r.result, 'review');
  await db.sql(`update public.billing_orders set status = 'pending', review_reason = null where id = $1`, [o.id]);
  const ok = await db.service(`select public.apply_verified_payment($1,'tx-1','slug1',14900,15200,2,'credit_card','https://r') r`, [o.order_nsu]);
  assert.equal(ok[0].r.result, 'activated');
  assert.equal(new Date(ok[0].r.period_end).toISOString(), '2026-04-08T16:00:00.000Z');
  const dup = await db.service(`select public.apply_verified_payment($1,'tx-1','slug1',14900,15200,2,'credit_card','https://r') r`, [o.order_nsu]);
  assert.equal(dup[0].r.result, 'duplicate_ignored');
  const second = await db.service(`select public.apply_verified_payment($1,'tx-2','slug1',14900,14900,1,'pix','') r`, [o.order_nsu]);
  assert.equal(second[0].r.result, 'review');
  const [s] = await db.sql(`select status, current_period_end from public.subscriptions where tenant_id = $1`, [A]);
  assert.equal(s.status, 'active');
  assert.equal(new Date(s.current_period_end).toISOString(), '2026-04-08T16:00:00.000Z');
  const unknown = await db.service(`select public.apply_verified_payment('nao-existe','tx-3','s',1,1,1,'pix','') r`);
  assert.equal(unknown[0].r.result, 'review');
});

test('cancelamento no teste: não gera pedido e reativação mantém a data original', async () => {
  const u = await db.createUser('cancel@x.test');
  db.setNow('2026-05-10T12:00:00Z');
  const t = (await provision(u, 'cond-cancel', '10203040000150', { plan: 'essencial', cycle: 'yearly' })).tenant_id;
  const [before] = await db.sql(`select trial_ends_at from public.subscriptions where tenant_id = $1`, [t]);
  await db.rpc(u, 'cancel_subscription', { p_tenant: t });
  await db.rpc(u, 'reactivate_subscription', { p_tenant: t });
  const [after] = await db.sql(`select trial_ends_at, cancel_at_period_end, price_cents_snapshot from public.subscriptions where tenant_id = $1`, [t]);
  assert.equal(String(after.trial_ends_at), String(before.trial_ends_at));
  assert.equal(after.price_cents_snapshot, 99000);
  // Troca de plano no teste mantém vencimento.
  await db.rpc(u, 'change_plan', { p_tenant: t, p_plan_code: 'prime', p_cycle: 'quarterly' });
  const [ch] = await db.sql(`select trial_ends_at, price_cents_snapshot from public.subscriptions where tenant_id = $1`, [t]);
  assert.equal(String(ch.trial_ends_at), String(before.trial_ends_at));
  assert.equal(ch.price_cents_snapshot, 89900);
  await db.rpc(u, 'cancel_subscription', { p_tenant: t });
  db.setNow('2026-06-11T12:00:00Z');
  await db.service(`select public.billing_tick()`);
  assert.equal((await db.sql(`select * from public.billing_orders where tenant_id = $1`, [t])).length, 0);
  const [s] = await db.sql(`select status from public.subscriptions where tenant_id = $1`, [t]);
  assert.equal(s.status, 'canceled');
});

test('fuso horário: término preserva horário local em outro fuso', async () => {
  const u = await db.createUser('tz@x.test');
  db.setNow('2026-03-31T03:30:00Z'); // 31/03 00:30 em São Paulo
  const t = (await provision(u, 'cond-tz', '20304050000160')).tenant_id;
  const [s] = await db.sql(`select to_char(trial_ends_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') e from public.subscriptions where tenant_id = $1`, [t]);
  assert.equal(s.e, '2026-04-30 00:30');
});

test('catálogo: anônimo vê só planos publicados; cliente não altera preço', async () => {
  await db.sql(`update public.plans set published = false where code = 'sob-medida'`);
  const plans = await db.as(null, `select code from public.plans`);
  assert.ok(!plans.some((p) => p.code === 'sob-medida'));
  // RLS filtra o UPDATE: nenhuma linha afetada e preço intacto (verifica efeito, não só erro).
  assert.equal((await db.as(adminA, `update public.plan_prices set amount_cents = 1 returning id`)).length, 0);
  const [{ n }] = await db.sql(`select count(*)::int n from public.plan_prices where amount_cents = 1`);
  assert.equal(n, 0);
  await rejects(db.rpc(adminA, 'admin_set_price', { p_plan_code: 'essencial', p_cycle: 'monthly', p_amount_cents: 1 }), /Sem permissão/);
});

test('storage: porteiro de B não envia arquivo para pasta de A; morador de B não lê', async () => {
  const [p] = await db.sql(`select id from public.packages where tenant_id = $1 limit 1`, [A]);
  await rejects(db.as(adminB, `insert into storage.objects (bucket_id, name) values ('tenant-private', $1)`, [`${A}/packages/${p.id}/label_photo-aaaaaaaa.jpg`]), /row-level/);
  await storeObject(`${A}/packages/${p.id}/label_photo-bbbbbbbb.jpg`);
  assert.equal((await db.as(morB, `select * from storage.objects where bucket_id = 'tenant-private'`)).length, 0);
  assert.ok((await db.as(portA, `select * from storage.objects where bucket_id = 'tenant-private'`)).length > 0);
});

test('anônimo não lê nada de negócio', async () => {
  await rejects(db.as(null, `select * from public.packages`), /permission denied/);
  await rejects(db.as(null, `select * from public.units`), /permission denied/);
  await rejects(db.as(null, `select public.receive_package(null,null,null,null,null)`), /permission denied|does not exist/);
});
