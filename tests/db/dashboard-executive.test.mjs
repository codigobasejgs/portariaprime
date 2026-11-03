// Dashboard executivo: definições (recebidas × entregues × coorte × saldo), período anterior,
// divisão por zero, granularidade, ranking paginado, filtros e isolamento entre condomínios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('dashboard executivo com base conhecida', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    db.setNow('2026-03-10T15:00:00Z'); // 12:00 em São Paulo
    const admin = await db.createUser('sindico@exec.invalid');
    const port = await db.createUser('porteiro@exec.invalid');
    const res = await db.createUser('morador@exec.invalid');
    const other = await db.createUser('outro@exec.invalid');
    const prov = (uid, name, slug, doc) => db.rpc(uid, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: name, p_slug: slug,
      p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
    const T = await prov(admin, 'Exec', 'exec-cond', '11444777000161');
    const O = await prov(other, 'Outro', 'outro-exec', '11222333000181');
    const [{ id: uA }] = await db.as(admin, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [T]);
    const [{ id: uB }] = await db.as(admin, "insert into units(tenant_id,block,label) values($1,'B','201') returning id", [T]);
    const [{ id: uO }] = await db.as(other, "insert into units(tenant_id,label) values($1,'1') returning id", [O]);
    for (const [email, role, unit] of [['porteiro@exec.invalid', 'porteiro', null], ['morador@exec.invalid', 'morador', uA]]) {
      const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: email, p_role: role, p_unit: unit, p_permissions: '{}' });
      await db.rpc(role === 'porteiro' ? port : res, 'accept_invitation', { p_token: inv.token });
    }
    const ins = (tenant, unit, received, status, x = {}) => db.service(`insert into packages(tenant_id,unit_id,status,carrier,idempotency_key,received_at,
      picked_up_at,picked_up_by_name,pickup_method,notified_at,resolution_reason,resolved_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [tenant, unit, status, x.carrier || 'Correios', crypto.randomUUID(), received, x.picked || null, x.picked ? 'X' : null, x.picked ? 'qr' : null,
      x.notified || null, x.resolved ? 'Endereço errado' : null, x.resolved || null]);

    // Período 09–10/03 (local -03); anterior 07–08/03.
    await ins(T, uA, '2026-03-08T12:00:00Z', 'RETIRADA', { picked: '2026-03-09T13:00:00Z', notified: '2026-03-08T12:30:00Z' }); // anterior; entregue no período (25 h)
    await ins(T, uA, '2026-03-09T12:00:00Z', 'RETIRADA', { picked: '2026-03-09T14:00:00Z', notified: '2026-03-09T13:00:00Z' }); // coorte retirada (2 h)
    await ins(T, uA, '2026-03-09T13:00:00Z', 'ARMAZENADA', { carrier: 'Shopee' });                                          // aguardando, 26 h
    await ins(T, uB, '2026-03-10T03:00:00Z', 'ARMAZENADA', { notified: '2026-03-10T05:00:00Z' });                             // aguardando, 12 h
    await ins(T, uB, '2026-03-09T12:00:00Z', 'DEVOLVIDA', { resolved: '2026-03-10T12:00:00Z' });                              // coorte exceção
    await ins(T, uB, '2026-03-05T12:00:00Z', 'ARMAZENADA');                                                                   // antiga: atrasada (> 72 h)
    await ins(T, uB, '2026-03-10T14:00:00Z', 'PRE_REGISTRADA');                                                                      // nunca conta
    await ins(O, uO, '2026-03-09T12:00:00Z', 'ARMAZENADA');                                                                   // outro condomínio

    const args = { p_tenant: T, p_from: '2026-03-09', p_to: '2026-03-10', p_filters: {} };
    const d = await db.rpc(admin, 'dashboard_executive', args);
    assert.deepEqual(d.received, { value: 4, previous: 1, change: 3 }, 'recebidas exclui PRE_REGISTRADA; anterior = mesma duração');
    assert.deepEqual(d.delivered, { value: 2, previous: 0, change: null }, 'entregues por picked_up_at; anterior 0 -> null');
    assert.deepEqual(d.cohort, { received: 4, picked: 1, exceptions: 1, rate: 0.25 });
    assert.equal(d.pending_now, 3);
    assert.equal(d.overdue_now, 1); assert.equal(d.overdue_hours, 72);
    assert.deepEqual(d.units_moved, { value: 2, previous: 1, change: 1 });
    assert.equal(d.pickup_time.avg_h, 13.5); assert.equal(d.pickup_time.median_h, 13.5); assert.equal(d.pickup_time.n, 2);
    assert.equal(d.efficiency.within_24h, 0.5); assert.equal(d.efficiency.within_48h, 1); assert.equal(d.efficiency.within_48h_previous, null);
    assert.deepEqual(d.efficiency.receipt_to_notice, { n: 2, without_notice: 2, avg_h: 1.5, median_h: 1.5 }, 'só quem tem notified_at');
    assert.deepEqual(d.efficiency.notice_to_pickup, { n: 2, avg_h: 12.8, median_h: 12.8 }); // (24,5 + 1) / 2
    assert.equal(d.granularity, 'day');
    // Saldo de abertura (fim de 08/03): 05/03 e 08/03 recebidas, nada encerrado = 2.
    // 09/03: +3 recebidas (12h, 13h, devolvida 12h) -1 retirada (08/03) -1 retirada (09/03) = 3.
    // 10/03: +1 (03:00Z = 00:00 local) -1 devolução = 3.
    assert.deepEqual(d.series.map((s) => [s.start, s.received, s.delivered, s.balance]), [['2026-03-09', 3, 2, 3], ['2026-03-10', 1, 0, 3]]);
    assert.equal(d.series.at(-1).balance, d.pending_now, 'saldo final = aguardando agora (sem filtros)');
    assert.deepEqual(d.aging_now, { lt24: 1, h24_48: 1, h48_72: 0, gt72: 1 });
    assert.equal(d.oldest_waiting.length, 3); assert.equal(d.oldest_waiting[0].unit, '201'); assert.equal(d.oldest_waiting[0].hours, 123);
    assert.ok(!JSON.stringify(d).includes('Endereço errado') && !('recent' in d), 'só agregados');
    assert.equal(d.recipients.available, false);
    assert.deepEqual(d.blocks.map((b) => [b.block, b.received, b.pending]), [['A', 2, 1], ['B', 2, 2]]);
    assert.deepEqual(d.options.blocks, ['A', 'B']); assert.deepEqual(d.options.carriers, ['Correios', 'Shopee']);
    assert.deepEqual(d.options.statuses, ['ARMAZENADA', 'DEVOLVIDA', 'RETIRADA'], 'só situações existentes, sem pré-registro');
    assert.deepEqual(d.options.units.map((u) => u.label), ['101', '201']);
    assert.deepEqual((await db.rpc(admin, 'dashboard_executive', { ...args, p_filters: { block: 'A' } })).options.blocks, ['A', 'B'], 'opções não dependem do filtro');
    assert.equal(d.heatmap.reduce((s, h) => s + h.n, 0), 4);

    // Filtros: bloco, unidade, transportadora, situação.
    const f = (filters) => db.rpc(admin, 'dashboard_executive', { ...args, p_filters: filters });
    assert.equal((await f({ block: 'b' })).received.value, 2, 'bloco sem diferenciar caixa');
    assert.equal((await f({ unit: uA })).pending_now, 1);
    assert.equal((await f({ carrier: 'Shopee' })).received.value, 1);
    assert.equal((await f({ status: 'PENDENTES' })).received.value, 2);
    assert.equal((await f({ status: 'RETIRADA' })).delivered.value, 2);
    await assert.rejects(f({ status: 'X' }), /situação/);
    await assert.rejects(f({ unit: 'nao-uuid' }), /unidade/);
    assert.equal((await f({ unit: uO })).received.value, 0, 'unidade de outro condomínio não vaza');

    // Divisão por zero e período vazio.
    const empty = await db.rpc(admin, 'dashboard_executive', { ...args, p_from: '2025-01-01', p_to: '2025-01-02' });
    assert.equal(empty.cohort.rate, null); assert.equal(empty.pickup_time.avg_h, null); assert.equal(empty.efficiency.within_24h, null);
    assert.equal(empty.received.change, null);
    // Granularidade automática e ano completo.
    assert.equal((await db.rpc(admin, 'dashboard_executive', { ...args, p_from: '2026-01-01', p_to: '2026-03-31' })).granularity, 'week');
    const year = await db.rpc(admin, 'dashboard_executive', { ...args, p_from: '2025-01-01', p_to: '2025-12-31' });
    assert.equal(year.granularity, 'month'); assert.equal(year.series.length, 12);
    const wk = await db.rpc(admin, 'dashboard_executive', { ...args, p_from: '2026-01-01', p_to: '2026-03-31' });
    assert.equal(wk.series[0].start, '2026-01-01', 'primeiro intervalo começa no início do período');
    assert.equal(wk.series.reduce((s, x) => s + x.received, 0), 6, 'soma da série = recebidas');
    await assert.rejects(db.rpc(admin, 'dashboard_executive', { ...args, p_from: '2025-01-01', p_to: '2026-03-10' }), /Período/);

    // Ranking paginado.
    const r = await db.rpc(admin, 'dashboard_unit_ranking', { ...args, p_limit: 1, p_offset: 0 });
    assert.equal(r.total, 2); assert.equal(r.received_total, 4);
    assert.deepEqual(r.items.map((i) => [i.block, i.unit, i.received, i.delivered, i.pending, i.share, i.change, i.avg_pickup_h]),
      [['A', '101', 2, 2, 1, 0.5, 1, 13.5]]);
    const r2 = await db.rpc(admin, 'dashboard_unit_ranking', { ...args, p_limit: 1, p_offset: 1 });
    assert.deepEqual(r2.items.map((i) => [i.unit, i.received, i.pending, i.change, i.avg_pickup_h]), [['201', 2, 2, null, null]]);
    assert.equal((await db.rpc(admin, 'dashboard_unit_ranking', { ...args, p_filters: { block: 'A' }, p_limit: 10, p_offset: 0 })).total, 1);

    // Permissão e isolamento: admin de outro condomínio, porteiro e morador recusados.
    for (const uid of [other, port, res, null]) {
      await assert.rejects(db.rpc(uid, 'dashboard_executive', args), /permissão|denied/i);
      await assert.rejects(db.rpc(uid, 'dashboard_unit_ranking', { ...args, p_limit: 10, p_offset: 0 }), /permissão|denied/i);
    }
    const o = await db.rpc(other, 'dashboard_executive', { ...args, p_tenant: O });
    assert.equal(o.received.value, 1); assert.equal(o.pending_now, 1);
    await assert.rejects(db.as(admin, "select app.dash_packages($1, '{}')", [T]), /permission denied/i);
  } finally { await db.raw.close(); }
});
