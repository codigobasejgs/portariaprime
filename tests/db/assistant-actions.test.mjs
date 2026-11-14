// Portaria Prime IA — ações novas executadas no banco (como a conta vinculada): níveis, isolamento entre condomínios,
// lote com teto de 20 e falhas parciais, reenvio de aviso com intervalo, palavra-chave, cancelamento só do admin,
// recusa de cadastro, importação de planilha (sem dados pessoais guardados depois) e auditoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('assistente: ações novas pelo WhatsApp respeitam nível, papel, condomínio e auditoria', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const svc = async (fn, args) => {
    const keys = Object.keys(args);
    const [row] = await db.service(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
    return row.r;
  };
  const save = async (uid, args) => {
    await db.raw.exec('begin');
    try {
      await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
        [uid, JSON.stringify({ sub: uid, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query('select public.assistant_link_save($1, null, $2, $3, $4, null, true) as r', [args.t, args.user, args.phone, args.level]);
      await db.raw.exec('commit');
      return r.rows[0].r;
    } catch (e) { await db.raw.exec('rollback'); throw e; }
  };
  const run = async (link, action, params) => {
    const p = await svc('assistant_propose', { p_link: link, p_action: action, p_params: params, p_summary: `teste ${action}` });
    return svc('assistant_confirm', { p_link: link, p_pending: p.id });
  };

  const sind = await db.createUser('s@act.invalid', { name: 'Síndica' });
  const sindB = await db.createUser('b@act.invalid', { name: 'Síndico B' });
  const por = await db.createUser('p@act.invalid', { name: 'Porteiro' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `C ${slug}`, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sind, 'act-a', '11444777000161');
  const B = await prov(sindB, 'act-b', '11222333000181');
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [A, por]);
  const [{ id: conc }] = await db.sql('select id from concierge_locations where tenant_id = $1', [A]);
  const [{ id: s1 }] = await db.sql(`insert into storage_locations(tenant_id,concierge_location_id,code,capacity) values($1,$2,'A1',30) returning id`, [A, conc]);
  const [{ id: s2 }] = await db.sql(`insert into storage_locations(tenant_id,concierge_location_id,code,capacity) values($1,$2,'B2',30) returning id`, [A, conc]);
  const [{ id: u101 }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'01A','101') returning id`, [A]);
  const [{ id: u11 }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'02B','11') returning id`, [A]);
  const [{ id: uB }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'X','1') returning id`, [B]);
  await db.sql(`insert into resident_contacts(tenant_id,unit_id,name,phone) values($1,$2,'Ana','5511988887777')`, [A, u101]);

  const adv = await save(sind, { t: A, user: sind, phone: '11999990001', level: 'advanced' });
  const basic = await save(sind, { t: A, user: sind, phone: '11999990002', level: 'basic' });
  const porL = await save(sind, { t: A, user: por, phone: '11999990003', level: 'intermediate' });
  const linkB = await save(sindB, { t: B, user: sindB, phone: '11999990004', level: 'advanced' });

  const recv = async (key, unit, by = por, tenant = A, shelf = s1) => {
    await db.rpc(by, 'receive_and_store', { p_tenant: tenant, p_idempotency_key: key, p_unit: unit, p_tracking: key, p_carrier: 'Shopee', p_recipient: 'Ana',
      p_notes: null, p_storage_location: shelf, p_label_sha256: null, p_courier: 'Lia', p_received_by_name: 'Porteiro' });
    return (await db.sql('select id from packages where upper(tracking_code) = upper($1)', [key]))[0].id;
  };
  const p1 = await recv('k-act-0001', u101);
  const p2 = await recv('k-act-0002', u101);
  const pB = await recv('k-act-b001', uB, sindB, B, null);
  await db.sql(`update packages set received_at = now() - interval '9 days' where id in ($1, $2)`, [p1, p2]);

  // --- Leituras novas: busca, estantes, moradores; isolamento (B não aparece em A).
  const found = await svc('assistant_read', { p_link: adv.id, p_kind: 'find_packages', p_args: { min_days: 7 } });
  assert.deepEqual(found.map((x) => x.id).sort(), [p1, p2].sort());
  assert.deepEqual(await svc('assistant_read', { p_link: adv.id, p_kind: 'find_packages', p_args: { q: 'k-act-b001' } }), [], 'outro condomínio invisível');
  const byRef = await svc('assistant_read', { p_link: adv.id, p_kind: 'find_packages', p_args: { q: `#${found[0].ref.toLowerCase()}` } });
  assert.equal(byRef.length, 1);
  assert.deepEqual((await svc('assistant_read', { p_link: adv.id, p_kind: 'find_packages', p_args: { id: p2 } })).map((x) => x.id), [p2], 'busca exata por id (botões)');
  assert.deepEqual(await svc('assistant_read', { p_link: adv.id, p_kind: 'find_packages', p_args: { id: pB } }), [], 'id de outro condomínio');
  const st = await svc('assistant_read', { p_link: basic.id, p_kind: 'storage', p_args: {} });
  assert.deepEqual(st.map((x) => [x.name.split(' › ').pop(), x.free]).sort(), [['A1', 28], ['B2', 30]]);

  // --- Nível: básico não propõe nenhuma ação nova; planilha exige avançado.
  for (const action of ['resend_notice', 'move_package', 'mark_unidentified', 'bulk_resend', 'keyword_create', 'invite_residents']) {
    await assert.rejects(svc('assistant_propose', { p_link: basic.id, p_action: action, p_params: { package_ids: [p1] }, p_summary: 'x' }), /nível/, action);
  }
  await assert.rejects(svc('assistant_propose', { p_link: porL.id, p_action: 'import_residents', p_params: { rows: [] }, p_summary: 'x' }), /nível/);
  await assert.rejects(svc('assistant_propose', { p_link: adv.id, p_action: 'apagar_tudo', p_params: {}, p_summary: 'x' }), /check/, 'ação fora da lista');

  // --- Reenviar aviso: enfileira; repetido em menos de 30 min é recusado.
  const r1 = await run(adv.id, 'resend_notice', { package_id: p1 });
  assert.equal(r1.status, 'done'); assert.ok(r1.result.jobs >= 1);
  const [{ n: jobs }] = await db.sql(`select count(*)::int n from notification_jobs where tenant_id = $1 and event = 'package_reminder' and ref_id like $2`, [A, `${p1}:%`]);
  assert.ok(jobs >= 1);
  const again = await run(adv.id, 'resend_notice', { package_id: p1 });
  assert.equal(again.status, 'failed'); assert.match(again.error, /30 minutos/);
  // Encomenda de outro condomínio: falha sem efeito.
  assert.equal((await run(adv.id, 'resend_notice', { package_id: pB })).status, 'failed');

  // --- Lote: teto de 20 no banco; falha parcial não desfaz os outros.
  const many = Array.from({ length: 21 }, () => p1);
  await assert.rejects(svc('assistant_propose', { p_link: adv.id, p_action: 'bulk_resend', p_params: { package_ids: many }, p_summary: 'x' }), /1 a 20/);
  const lot = await run(adv.id, 'bulk_resend', { package_ids: [p1, p2, pB] });
  assert.equal(lot.status, 'done');
  assert.equal(lot.result.ok, 1, 'p2 reenviado; p1 dentro do intervalo; pB de outro condomínio');
  assert.equal(lot.result.failed.length, 2);

  // --- Mover e marcar sem identificação (porteiro intermediário pode).
  assert.equal((await run(porL.id, 'move_package', { package_id: p2, storage_location_id: s2 })).status, 'done');
  assert.equal((await db.sql('select storage_location_id s from packages where id = $1', [p2]))[0].s, s2);
  assert.equal((await run(porL.id, 'mark_unidentified', { package_id: p2, reason: 'incomplete_or_unknown_name' })).status, 'done');

  // --- Cancelar/extravio: porteiro não; síndico sim.
  const cx = await run(porL.id, 'cancel_package', { package_id: p2, status: 'EXTRAVIADA', reason: 'Não localizada na conferência.' });
  assert.equal(cx.status, 'failed'); assert.match(cx.error, /administrador/);
  assert.equal((await run(adv.id, 'cancel_package', { package_id: p2, status: 'EXTRAVIADA', reason: 'Não localizada na conferência.' })).status, 'done');
  assert.equal((await db.sql('select status from packages where id = $1', [p2]))[0].status, 'EXTRAVIADA');

  // --- Devolução em lote.
  const ret = await run(adv.id, 'bulk_return', { package_ids: [p1], reason: 'Prazo de retirada vencido.' });
  assert.deepEqual([ret.status, ret.result.ok], ['done', 1]);
  assert.equal((await db.sql('select status from packages where id = $1', [p1]))[0].status, 'DEVOLVIDA');

  // --- Palavra-chave: equipe cria para a unidade; não cria em unidade de outro condomínio; cancela.
  const kw = await run(porL.id, 'keyword_create', { unit_id: u11, keyword: 'AZUL', carrier: 'Shopee' });
  assert.equal(kw.status, 'done');
  const [k] = await db.sql('select id, unit_id, created_by from delivery_keywords where keyword = $1', ['AZUL']);
  assert.deepEqual([k.unit_id, k.created_by], [u11, por]);
  assert.equal((await run(porL.id, 'keyword_create', { unit_id: uB, keyword: 'VERDE' })).status, 'failed');
  assert.equal((await run(adv.id, 'keyword_cancel', { keyword_id: k.id })).status, 'done');
  assert.equal((await db.sql('select status from delivery_keywords where id = $1', [k.id]))[0].status, 'cancelled');

  // --- Recusar cadastro (pedido de outro condomínio não).
  const mor = await db.createUser('m@act.invalid', { name: 'Morador' });
  const [{ id: req }] = await db.sql(`insert into access_requests(tenant_id,user_id,full_name,unit_text,unit_id) values($1,$2,'Morador X','11',$3) returning id`, [A, mor, u11]);
  assert.equal((await run(adv.id, 'reject_resident', { request_id: req, reason: 'Não mora no condomínio.' })).status, 'done');
  assert.equal((await db.sql('select status from access_requests where id = $1', [req]))[0].status, 'rejected');

  // --- Planilha: grava o pré-cadastro e apaga nomes/telefones da proposta depois de executar.
  const imp = await run(adv.id, 'import_residents', { rows: [{ unit_id: u101, full_name: 'Bia Souza', kind: null, phone: '+5511977776666', email: null, extra: {} }], stats: { pessoas: 1 } });
  assert.equal(imp.status, 'done'); assert.equal(imp.result.inserted, 1);
  const [{ params }] = await db.sql(`select params from assistant_pending where action = 'import_residents' order by created_at desc limit 1`);
  assert.deepEqual(params, { redacted: true, stats: { pessoas: 1 } });
  const cross = await run(linkB.id, 'import_residents', { rows: [{ unit_id: u101, full_name: 'Intrusa', kind: null, phone: null, email: null, extra: {} }], stats: {} });
  assert.deepEqual([cross.result.inserted, cross.result.skipped], [0, 1], 'vínculo de B: unidade de A é ignorada');
  assert.equal((await db.sql(`select count(*)::int n from resident_import_entries where full_name = 'Intrusa'`))[0].n, 0);

  // --- Auditoria com a origem.
  const audit = await db.sql(`select action, data->>'via' via from audit_logs where tenant_id = $1 and action like 'assistant.%' and action <> 'assistant.link_saved'`, [A]);
  for (const a of ['assistant.resend_notice', 'assistant.bulk_resend', 'assistant.move_package', 'assistant.cancel_package', 'assistant.keyword_create', 'assistant.import_residents']) {
    assert.ok(audit.some((x) => x.action === a && x.via === 'Portaria Prime IA (WhatsApp)'), a);
  }
});
