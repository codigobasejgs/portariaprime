// Relatórios gerenciais e gerador de unidades (migration 20261104000200).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('relatórios: filtros exatos, totais iguais às linhas, isolamento e gerador de unidades', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const sind = await db.createUser('s@a.invalid', { name: 'Síndica A' });
    const sindB = await db.createUser('s@b.invalid', { name: 'Síndico B' });
    const port = await db.createUser('p@a.invalid', { name: 'Porteiro Ze' });
    const mor = await db.createUser('m@a.invalid', { name: 'Maria Silva' });
    const { tenant_id: A } = await db.rpc(sind, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond A', p_slug: 'rel-a', p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
    const { tenant_id: B } = await db.rpc(sindB, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond B', p_slug: 'rel-b', p_document: '04252011000110', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });

    // Gerador: prévia não grava; blocos A e B, andares 1–3, 2 por andar = 12 unidades (101,102,201…).
    const spec = { mode: 'floors', blocks: ['A', 'B'], floor_from: '1', floor_to: '3', per_floor: '2' };
    const prev = await db.rpc(sind, 'units_generate', { p_tenant: A, p_spec: spec, p_dry_run: true });
    assert.equal(prev.count, 12); assert.equal(prev.valid, 12); assert.equal(prev.written, 0);
    assert.deepEqual(prev.preview.slice(0, 3).map((x) => `${x.block}-${x.label}`), ['A-101', 'A-102', 'A-201']);
    assert.equal((await db.sql('select count(*)::int n from units where tenant_id=$1', [A]))[0].n, 0, 'prévia não grava');
    assert.equal((await db.rpc(sind, 'units_generate', { p_tenant: A, p_spec: spec, p_dry_run: false })).written, 12);
    // Repetir: tudo-ou-nada, recusa duplicadas sem gravar nada.
    const again = await db.rpc(sind, 'units_generate', { p_tenant: A, p_spec: spec, p_dry_run: false });
    assert.equal(again.written, 0); assert.equal(again.errors.length, 12);
    // Intervalo simples sem bloco; limites e validação.
    assert.equal((await db.rpc(sind, 'units_generate', { p_tenant: A, p_spec: { mode: 'range', blocks: [''], from: '1', to: '3', prefix: 'Casa ' }, p_dry_run: true })).preview[0].label, 'Casa 1');
    await assert.rejects(db.rpc(sind, 'units_generate', { p_tenant: A, p_spec: { mode: 'range', blocks: ['A'], from: '1', to: '5000' }, p_dry_run: true }), /Intervalo inválido/);
    await assert.rejects(db.rpc(sind, 'units_generate', { p_tenant: A, p_spec: { mode: 'floors', blocks: ['A'], floor_from: 'x', floor_to: '2', per_floor: '2' }, p_dry_run: true }), /inválidos/);
    await assert.rejects(db.rpc(sindB, 'units_generate', { p_tenant: A, p_spec: spec, p_dry_run: true }), /permission|Sem permiss|Acesso/i, 'outro condomínio não gera aqui');

    // Encomendas: porteiro e morador em A.
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'porteiro','{}','active'),($1,$3,'morador','{}','active')", [A, port, mor]);
    const [{ id: a101 }] = await db.sql("select id from units where tenant_id=$1 and block='A' and label='101'", [A]);
    const [{ id: b201 }] = await db.sql("select id from units where tenant_id=$1 and block='B' and label='201'", [A]);
    await db.sql("insert into unit_memberships (tenant_id, unit_id, user_id) values ($1,$2,$3)", [A, a101, mor]);
    const pk = async (unit, carrier, status, receivedAt, by, extra = {}) => (await db.sql(
      `insert into packages (tenant_id, unit_id, carrier, status, received_at, received_by, recipient_name, tracking_code, picked_up_at, picked_up_by_name, pickup_method, delivered_by, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, gen_random_uuid()::text) returning id`,
      [A, unit, carrier, status, receivedAt, by, extra.recipient || 'Maria Silva', extra.tracking || null,
        status === 'RETIRADA' ? extra.picked : null, status === 'RETIRADA' ? 'Maria' : null, status === 'RETIRADA' ? 'qr' : null, status === 'RETIRADA' ? port : null]))[0].id;
    await pk(a101, 'Correios', 'RECEBIDA', '2026-01-10T13:00:00Z', port, { tracking: 'BR111' });
    await pk(a101, 'Shopee', 'RETIRADA', '2026-02-05T13:00:00Z', port, { picked: '2026-02-06T13:00:00Z' });
    await pk(b201, 'Correios', 'RETIRADA', '2026-03-01T13:00:00Z', sind, { picked: '2026-03-04T13:00:00Z', recipient: 'Joao Souza' });
    await pk(b201, 'Amazon', 'ARMAZENADA', '2026-03-20T13:00:00Z', port);
    // Encomenda de B não pode aparecer em A.
    const [{ id: bu }] = await db.sql("insert into units (tenant_id, block, label) values ($1,'A','101') returning id", [B]);
    await db.sql("insert into packages (tenant_id, unit_id, carrier, status, received_at, idempotency_key) values ($1,$2,'Correios','RECEBIDA','2026-01-10T13:00:00Z', gen_random_uuid()::text)", [B, bu]);

    const rep = (f) => db.rpc(sind, 'report_packages', { p_tenant: A, p_filters: f, p_limit: 1000 });
    const sum = (f) => db.rpc(sind, 'report_packages_summary', { p_tenant: A, p_filters: f });
    assert.equal((await rep({})).length, 4, 'só o próprio condomínio');
    const cases = [
      [{ block: 'A' }, 2], [{ block: 'b' }, 2], [{ unit: b201 }, 2], [{ carrier: 'Correios' }, 2], [{ status: 'PENDENTES' }, 2],
      [{ status: 'RETIRADA' }, 2], [{ received_from: '2026-02-01', received_to: '2026-03-01' }, 2], [{ picked_from: '2026-03-01' }, 1],
      [{ operator: sind }, 1], [{ operator: port }, 4], [{ recipient: 'joao' }, 1], [{ search: 'BR1' }, 1], [{ block: 'A', carrier: 'Shopee' }, 1],
      [{ recipient: '%' }, 0],
    ];
    for (const [f, n] of cases) {
      const rows = await rep(f);
      assert.equal(rows.length, n, JSON.stringify(f));
      assert.equal((await sum(f)).total, n, `totais = linhas ${JSON.stringify(f)}`);
    }
    const s = await sum({});
    assert.deepEqual([s.total, s.pending, s.picked, s.exceptions], [4, 2, 2, 0]);
    assert.equal(s.top_units[0].n, 2);
    assert.equal(s.by_carrier[0].carrier, 'Correios');
    const r1 = (await rep({ unit: a101, status: 'RETIRADA' }))[0];
    assert.equal(r1.received_by_name, 'Porteiro Ze'); assert.equal(r1.delivered_by_name, 'Porteiro Ze'); assert.equal(r1.hours_waiting, 24);
    // Paginação por cursor: sem perder nem repetir.
    const p1 = await db.rpc(sind, 'report_packages', { p_tenant: A, p_filters: {}, p_limit: 3 });
    const last = p1[p1.length - 1];
    const p2 = await db.rpc(sind, 'report_packages', { p_tenant: A, p_filters: {}, p_limit: 3, p_cursor_at: last.received_at, p_cursor_id: last.id });
    assert.equal(new Set([...p1, ...p2].map((x) => x.id)).size, 4);
    // Validação e autorização.
    await assert.rejects(rep({ evil: '1' }), /desconhecido/);
    await assert.rejects(rep({ unit: 'nao-uuid' }), /valor inválido/);
    await assert.rejects(rep({ received_from: '2026-13-40' }), /valor inválido/);
    await assert.rejects(rep({ status: 'X' }), /Situação inválida/);
    await assert.rejects(rep({ block: { $ne: 1 } }), /Filtro inválido/);
    for (const [who, label] of [[port, 'porteiro'], [mor, 'morador'], [sindB, 'síndico de B']]) {
      await assert.rejects(db.rpc(who, 'report_packages', { p_tenant: A, p_filters: {} }), /Somente a administração/, label);
      await assert.rejects(db.rpc(who, 'report_packages_summary', { p_tenant: A, p_filters: {} }), /Somente a administração/, label);
      await assert.rejects(db.rpc(who, 'report_filter_options', { p_tenant: A }), /Somente a administração/, label);
      await assert.rejects(db.rpc(who, 'report_residents', { p_tenant: A, p_filters: {} }), /Somente quem/, label);
    }
    await assert.rejects(db.rpc(null, 'report_packages', { p_tenant: A, p_filters: {} }), /permission denied/);
    const opt = await db.rpc(sind, 'report_filter_options', { p_tenant: A });
    assert.deepEqual(opt.blocks, ['A', 'B']); assert.deepEqual(opt.carriers, ['Amazon', 'Correios', 'Shopee']);
    assert.deepEqual(opt.operators.map((o) => o.role).sort(), ['admin', 'porteiro']);

    // Moradores: unidades com e sem morador, pendente e recusado.
    const pend = await db.createUser('pend@a.invalid', { name: 'Pedro Pend' });
    await db.sql("insert into access_requests (tenant_id, user_id, full_name, unit_text, unit_id, status) values ($1,$2,'Pedro Pend','201',$3,'pending')", [A, pend, b201]);
    const all = await db.rpc(sind, 'report_residents', { p_tenant: A, p_filters: {} });
    assert.ok(all.some((x) => x.label === '101' && x.block === 'A' && x.status === 'active' && x.full_name === 'Maria Silva'));
    assert.ok(all.some((x) => x.label === '201' && x.block === 'B' && x.status === 'pending'));
    const res = (f) => db.rpc(sind, 'report_residents', { p_tenant: A, p_filters: f });
    assert.equal((await res({ status: 'active' })).length, 1);
    assert.equal((await res({ status: 'pending' })).length, 1);
    assert.equal((await res({ occupancy: 'with' })).length, 1, 'só A-101 tem morador ativo');
    assert.equal((await res({ occupancy: 'without' })).filter((x) => x.user_id === null).length, 10, 'unidades sem ninguém');
    assert.equal((await res({ block: 'A', occupancy: 'without' })).length, 5);
    assert.equal((await res({ search: 'maria' })).length, 1);
    await assert.rejects(res({ status: 'x' }), /Situação inválida/);
    await assert.rejects(res({ hack: '1' }), /Filtro inválido/);
    assert.ok(!(await db.rpc(sindB, 'report_residents', { p_tenant: B, p_filters: {} })).some((x) => x.full_name === 'Maria Silva'), 'B não vê moradores de A');

    // Inventário: definer + search_path vazio, nada para anon.
    const fns = await db.sql(`select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') cfg, has_function_privilege('anon', p.oid, 'execute') anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('report_packages','report_packages_summary','report_filter_options','report_residents','units_generate')`);
    assert.equal(fns.length, 5);
    for (const f of fns) { assert.ok(f.prosecdef, f.proname); assert.match(f.cfg, /search_path=("")?$/, f.proname); assert.equal(f.anon, false, f.proname); }
  } finally { await db.raw.close(); }
});
