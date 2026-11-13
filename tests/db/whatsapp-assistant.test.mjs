// Portaria Prime IA (WhatsApp): vínculo por telefone, isolamento entre condomínios, 3 níveis,
// Resumo -> Confirmar/Cancelar antes de gravar, expiração de 10 min, auditoria e relatórios por período.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('assistente do WhatsApp: segurança, níveis, confirmação e relatórios', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const svc = async (fn, args) => {
    const keys = Object.keys(args);
    const [row] = await db.service(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
    return row.r;
  };
  const fails = async (p, re, msg) => { await assert.rejects(p, re, msg); };
  const fresh = async (uid, fn, args, recent = true) => {
    const keys = Object.keys(args);
    await db.raw.exec('begin');
    try {
      const amr = recent ? [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] : [];
      await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [uid, JSON.stringify({ sub: uid, amr })]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
      await db.raw.exec('commit');
      return r.rows[0].r;
    } catch (e) { await db.raw.exec('rollback'); throw e; }
  };

  const sind = await db.createUser('s@wa.invalid', { name: 'Síndica A' });
  const sindB = await db.createUser('b@wa.invalid', { name: 'Síndico B' });
  const por = await db.createUser('p@wa.invalid', { name: 'Porteiro A' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `C ${slug}`, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sind, 'wa-a', '11444777000161');
  const B = await prov(sindB, 'wa-b', '11222333000181');
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [A, por]);
  const [{ id: conc }] = await db.sql('select id from concierge_locations where tenant_id = $1', [A]);
  const [{ id: shelf }] = await db.sql(`insert into storage_locations(tenant_id,concierge_location_id,code,capacity) values($1,$2,'A1',10) returning id`, [A, conc]);
  const [{ id: u101 }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'01A','101') returning id`, [A]);
  const [{ id: u202 }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'02B','11') returning id`, [A]);
  const [{ id: uB }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'X','1') returning id`, [B]);

  // --- Painel: só quem tem 'team' cadastra; porteiro e outro condomínio não.
  await fails(fresh(por, 'assistant_link_save', { p_tenant: A, p_id: null, p_user: por, p_phone: '11999990001', p_level: 'basic', p_label: null, p_active: true }), /gerencia a equipe/);
  await fails(fresh(sindB, 'assistant_link_save', { p_tenant: A, p_id: null, p_user: sindB, p_phone: '11999990001', p_level: 'basic', p_label: null, p_active: true }), /gerencia a equipe/);
  await fails(fresh(sind, 'assistant_link_save', { p_tenant: A, p_id: null, p_user: sindB, p_phone: '11999990009', p_level: 'basic', p_label: null, p_active: true }), /pessoa ativa da equipe/,
    'não vincula conta de outro condomínio');
  await fails(fresh(sind, 'assistant_link_save', { p_tenant: A, p_id: null, p_user: por, p_phone: '11999990001', p_level: 'basic', p_label: null, p_active: true }, false), /Confirme sua senha/,
    'cadastrar número exige login recente');
  const basic = await fresh(sind, 'assistant_link_save', { p_tenant: A, p_id: null, p_user: por, p_phone: '(11) 99999-0001', p_level: 'basic', p_label: 'Portaria', p_active: true });
  const adv = await fresh(sind, 'assistant_link_save', { p_tenant: A, p_id: null, p_user: sind, p_phone: '5511999990002', p_level: 'advanced', p_label: null, p_active: true });
  assert.equal(basic.phone, '5511999990001');
  await fails(fresh(sind, 'assistant_link_save', { p_tenant: A, p_id: null, p_user: sind, p_phone: '11999990002', p_level: 'basic', p_label: null, p_active: true }), /já está cadastrado/);
  await fresh(sindB, 'assistant_link_save', { p_tenant: B, p_id: null, p_user: sindB, p_phone: '11999990002', p_level: 'advanced', p_label: null, p_active: true });
  assert.equal((await db.rpc(sind, 'assistant_links_list', { p_tenant: A })).length, 2);

  // --- Tabelas sem acesso direto; RPCs do webhook só para service_role.
  for (const t of ['assistant_links', 'assistant_pending', 'assistant_sessions', 'assistant_messages']) {
    const [p] = await db.sql(`select has_table_privilege('authenticated', $1, 'select') s, has_table_privilege('anon', $1, 'select') a`, [`public.${t}`]);
    assert.deepEqual([p.s, p.a], [false, false], `${t}: sem acesso direto`);
  }
  await fails(db.rpc(sind, 'assistant_read', { p_link: adv.id, p_kind: 'today', p_args: {} }), /permission denied/);
  await fails(db.rpc(sind, 'assistant_confirm', { p_link: adv.id, p_pending: crypto.randomUUID() }), /permission denied/);

  // --- Resolução por telefone: formato sem 9º dígito; mesmo número em dois condomínios = dois vínculos, cada um isolado.
  const res = await svc('assistant_resolve', { p_phone: '551199990002' });
  assert.deepEqual(res.map((r) => r.tenant_name).sort(), ['C wa-a', 'C wa-b']);
  assert.deepEqual(await svc('assistant_resolve', { p_phone: '5511988887777' }), [], 'número desconhecido não acessa nada');
  const linkB = res.find((r) => r.tenant_id === B).link_id;

  // Dados: encomendas em A (uma parada há 8 dias, uma recusada) e em B.
  await db.rpc(por, 'receive_and_store', { p_tenant: A, p_idempotency_key: 'k-wa-0001', p_unit: u101, p_tracking: 'BR1', p_carrier: 'Shopee', p_recipient: 'Ana',
    p_notes: null, p_storage_location: shelf, p_label_sha256: null, p_courier: 'Lia - Shopee', p_received_by_name: 'Porteiro A' });
  const [{ id: old }] = await db.sql('select id from packages where tracking_code = $1', ['BR1']);
  await db.sql(`update packages set received_at = now() - interval '8 days' where id = $1`, [old]);
  await db.rpc(sindB, 'receive_and_store', { p_tenant: B, p_idempotency_key: 'k-wa-b001', p_unit: uB, p_tracking: 'BRB', p_carrier: 'Correios', p_recipient: 'Zé',
    p_notes: null, p_storage_location: null, p_label_sha256: null, p_courier: 'Correio B', p_received_by_name: 'Síndico B' });

  // --- Leitura: cada vínculo só enxerga o próprio condomínio.
  const todayA = await svc('assistant_read', { p_link: adv.id, p_kind: 'today', p_args: {} });
  assert.equal(todayA.waiting, 1); assert.equal(todayA.overdue_7d, 1);
  assert.equal((await svc('assistant_read', { p_link: linkB, p_kind: 'today', p_args: {} })).waiting, 1);
  const byUnit = await svc('assistant_read', { p_link: basic.id, p_kind: 'pending_by_unit', p_args: { block: 'Bloco 01A' } });
  assert.equal(byUnit.length, 1); assert.equal(byUnit[0].days, 8);
  assert.equal((await svc('assistant_read', { p_link: basic.id, p_kind: 'pending_by_unit', p_args: { block: 'X' } })).length, 0, 'bloco de B não aparece em A');
  // Porteiro não vê o que o painel não mostra a ele (cadastros pendentes, relatórios do síndico).
  assert.equal((await svc('assistant_read', { p_link: basic.id, p_kind: 'today', p_args: {} })).access_requests, 0);
  await fails(svc('assistant_read', { p_link: basic.id, p_kind: 'report', p_args: { period: 'month' } }), /permissão/i);

  // --- Relatórios: hoje, mês, 3m, 6m e ano (síndico).
  for (const period of ['today', 'month', '3m', '6m', 'year']) {
    const r = await svc('assistant_read', { p_link: adv.id, p_kind: 'report', p_args: { period } });
    assert.ok(r.from && r.to && Number.isFinite(Number(r.received)), `relatório ${period}`);
    assert.ok(Array.isArray(r.carriers) && Array.isArray(r.porters), `relatório ${period}: rankings`);
  }
  const year = await svc('assistant_read', { p_link: adv.id, p_kind: 'report', p_args: { period: 'year' } });
  assert.equal(Number(year.received), 1); assert.equal(year.porters[0].name, 'Porteiro A'); assert.equal(Number(year.couriers), 1);
  const today = await svc('assistant_read', { p_link: adv.id, p_kind: 'report', p_args: { period: 'today' } });
  assert.equal(Number(today.received), 0, 'hoje não conta a de 8 dias atrás');
  await fails(svc('assistant_read', { p_link: adv.id, p_kind: 'report', p_args: { period: '10y' } }), /Período inválido/);

  // --- Nível básico não propõe nem executa mutações.
  await fails(svc('assistant_propose', { p_link: basic.id, p_action: 'return_package', p_params: { package_id: old, reason: 'Recusada no balcão.' }, p_summary: 'x' }), /nível/);

  // --- Intermediário: Resumo -> Cancelar não grava; Resumo -> Confirmar grava uma vez, com auditoria.
  await fresh(sind, 'assistant_link_save', { p_tenant: A, p_id: basic.id, p_user: por, p_phone: '11999990001', p_level: 'intermediate', p_label: 'Portaria', p_active: true });
  const reason = 'Devolvida: endereço de outro prédio.';
  const p1 = await svc('assistant_propose', { p_link: basic.id, p_action: 'return_package', p_params: { package_id: old, reason }, p_summary: 'Devolver BR1' });
  assert.deepEqual(await svc('assistant_cancel', { p_link: basic.id, p_pending: p1.id }), { cancelled: true });
  assert.equal((await db.sql('select status from packages where id = $1', [old]))[0].status, 'ARMAZENADA', 'cancelar não grava');
  assert.equal((await svc('assistant_confirm', { p_link: basic.id, p_pending: p1.id })).status, 'cancelled', 'cancelada não executa depois');

  const p2 = await svc('assistant_propose', { p_link: basic.id, p_action: 'return_package', p_params: { package_id: old, reason }, p_summary: 'Devolver BR1' });
  // Outro número não confirma a ação deste.
  await fails(svc('assistant_confirm', { p_link: adv.id, p_pending: p2.id }), /não encontrada/);
  const ok = await svc('assistant_confirm', { p_link: basic.id, p_pending: p2.id });
  assert.equal(ok.status, 'done');
  assert.equal((await db.sql('select status from packages where id = $1', [old]))[0].status, 'DEVOLVIDA');
  const again = await svc('assistant_confirm', { p_link: basic.id, p_pending: p2.id });
  assert.equal(again.replayed, true, 'confirmar duas vezes não repete a ação');
  const [audit] = await db.sql(`select actor_id, data from audit_logs where action = 'assistant.return_package'`);
  assert.equal(audit.actor_id, por); assert.equal(audit.data.via, 'Portaria Prime IA (WhatsApp)');

  // Regra do sistema continua valendo: porteiro não cancela encomenda (só devolve). Falha fica registrada, nada grava.
  const p3 = await svc('assistant_propose', { p_link: basic.id, p_action: 'return_package', p_params: { package_id: old, reason }, p_summary: 'de novo' });
  const failed = await svc('assistant_confirm', { p_link: basic.id, p_pending: p3.id });
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /finalizada/);

  // --- Expiração: depois de 10 minutos a confirmação não executa.
  db.setNow(new Date(Date.now()).toISOString());
  const p4 = await svc('assistant_propose', { p_link: adv.id, p_action: 'keyword_used', p_params: { keyword_id: crypto.randomUUID() }, p_summary: 'x' });
  db.setNow(new Date(Date.now() + 11 * 60_000).toISOString());
  assert.equal((await svc('assistant_confirm', { p_link: adv.id, p_pending: p4.id })).status, 'expired');
  db.setNow(null);

  // --- Foto (registro) exige nível avançado; intermediário não.
  const recv = { unit_id: u202, carrier: 'Correios', tracking: 'BRWA1', recipient: 'João', storage_location_id: shelf, courier: 'Carlos', received_by: 'Porteiro A' };
  await fails(svc('assistant_propose', { p_link: basic.id, p_action: 'receive_package', p_params: recv, p_summary: 'x' }), /nível/);
  const p5 = await svc('assistant_propose', { p_link: adv.id, p_action: 'receive_package', p_params: recv, p_summary: 'Registrar BRWA1' });
  assert.equal((await svc('assistant_confirm', { p_link: adv.id, p_pending: p5.id })).status, 'done');
  const [pk] = await db.sql(`select tenant_id, status, received_by from packages where tracking_code = 'BRWA1'`);
  assert.deepEqual([pk.tenant_id, pk.status, pk.received_by], [A, 'ARMAZENADA', sind], 'gravada no condomínio certo, em nome da conta vinculada');

  // Unidade de outro condomínio nos parâmetros: a RPC do sistema recusa (sem IDOR).
  const p6 = await svc('assistant_propose', { p_link: adv.id, p_action: 'receive_package', p_params: { ...recv, unit_id: uB, tracking: 'BRWA2' }, p_summary: 'x' });
  assert.equal((await svc('assistant_confirm', { p_link: adv.id, p_pending: p6.id })).status, 'failed');
  assert.equal((await db.sql(`select count(*)::int n from packages where tracking_code = 'BRWA2'`))[0].n, 0);

  // --- Conta revogada ou número desativado: o vínculo para de funcionar na hora.
  await db.sql(`update tenant_memberships set status = 'revoked' where tenant_id = $1 and user_id = $2`, [A, por]);
  assert.deepEqual((await svc('assistant_resolve', { p_phone: '11999990001' })), []);
  await fails(svc('assistant_read', { p_link: basic.id, p_kind: 'today', p_args: {} }), /não autorizado/);

  // --- Limpeza diária.
  const hk = await svc('assistant_housekeeping', {});
  assert.ok(Number.isInteger(hk.expired));
});

test('assistente: sem escalada, porteiro em turno, outro condomínio da mesma conta, limites e LGPD', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const svc = async (fn, args) => {
    const keys = Object.keys(args);
    const [row] = await db.service(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
    return row.r;
  };
  const fresh = async (uid, fn, args) => {
    const keys = Object.keys(args);
    await db.raw.exec('begin');
    try {
      await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
        [uid, JSON.stringify({ sub: uid, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
      await db.raw.exec('commit');
      return r.rows[0].r;
    } catch (e) { await db.raw.exec('rollback'); throw e; }
  };
  const link = (by, t, user, phone, level = 'intermediate') => fresh(by, 'assistant_link_save', { p_tenant: t, p_id: null, p_user: user, p_phone: phone, p_level: level, p_label: null, p_active: true });

  const owner = await db.createUser('o@wa2.invalid', { name: 'Síndica dona' });
  const prov = (slug, doc) => db.rpc(owner, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `C ${slug}`, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov('wa2-a', '11444777000161');
  const B = await prov('wa2-b', '11222333000181');   // a mesma conta administra A e B

  // Admin só com 'team' (sem 'approve') não vincula o WhatsApp dele à conta da síndica (que aprova moradores).
  const teamOnly = await db.createUser('t@wa2.invalid', { name: 'Admin equipe' });
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status,permissions) values($1,$2,'admin','active','{team}')`, [A, teamOnly]);
  await assert.rejects(link(teamOnly, A, owner, '11988880001'), /mais permissões que você/, 'sem escalada para conta mais poderosa');
  await link(teamOnly, A, teamOnly, '11988880002');   // o próprio número, com as próprias permissões, pode

  // Porteiro com identidade biométrica (opera só em turno no painel): fora do assistente.
  const bio = await db.createUser('b@wa2.invalid', { name: 'Porteiro bio' });
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [A, bio]);
  await db.sql(`insert into porter_identities(tenant_id,user_id,full_name,document_type,document_hash,document_masked,phone) values($1,$2,'Porteiro bio','CPF','h','CPF •••0000','11999990000')`, [A, bio]);
  await link(owner, A, bio, '11988880003', 'basic');
  assert.deepEqual(await svc('assistant_resolve', { p_phone: '11988880003' }), [], 'porteiro biométrico não usa o assistente sem turno');

  // Pedido de cadastro de B não é aprovado por um vínculo de A, mesmo sendo a mesma conta nos dois condomínios.
  const lA = await link(owner, A, owner, '11988880004');
  const [{ id: ub }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'B','1') returning id`, [B]);
  const mor = await db.createUser('m@wa2.invalid', { name: 'Morador B' });
  const [{ id: reqB }] = await db.sql(`insert into access_requests(tenant_id,user_id,full_name,unit_text,unit_id) values($1,$2,'Morador B','1',$3) returning id`, [B, mor, ub]);
  const p = await svc('assistant_propose', { p_link: lA.id, p_action: 'approve_resident', p_params: { request_id: reqB, unit_id: ub }, p_summary: 'x' });
  const r = await svc('assistant_confirm', { p_link: lA.id, p_pending: p.id });
  assert.equal(r.status, 'failed'); assert.match(r.error, /neste condomínio/);
  assert.equal((await db.sql('select status from access_requests where id = $1', [reqB]))[0].status, 'pending');

  // Limites: 21ª mensagem em 10 min do mesmo telefone é barrada; orçamento de IA por condomínio.
  for (let i = 0; i < 21; i++) await db.service('insert into assistant_messages(provider_id, phone) values($1, $2)', [`MSGRATE${i}`, '5511988880004']);
  assert.deepEqual(await svc('assistant_rate', { p_link: lA.id, p_phone: '11988880004', p_ai: false }), { ok: false, reason: 'phone' });
  await db.service('delete from assistant_messages');
  await db.sql('insert into assistant_ai_usage(tenant_id, day, n) values($1, (now() at time zone $2)::date, 400)', [A, 'America/Sao_Paulo']);
  assert.deepEqual(await svc('assistant_rate', { p_link: lA.id, p_phone: '11988880004', p_ai: false }), { ok: true }, 'botões não gastam IA');
  assert.deepEqual(await svc('assistant_rate', { p_link: lA.id, p_phone: '11988880004', p_ai: true }), { ok: false, reason: 'tenant' });

  // LGPD: CPF/CNH da proposta somem 1 dia depois de encerrada.
  const lAdv = await fresh(owner, 'assistant_link_save', { p_tenant: A, p_id: lA.id, p_user: owner, p_phone: '11988880004', p_level: 'advanced', p_label: null, p_active: true });
  const c = await svc('assistant_propose', { p_link: lAdv.id, p_action: 'register_courier', p_params: { full_name: 'Rodrigo', cpf: '52998224725', cnh: '01234567890' }, p_summary: 'x' });
  await svc('assistant_cancel', { p_link: lAdv.id, p_pending: c.id });
  await db.sql(`update assistant_pending set decided_at = now() - interval '2 days' where id = $1`, [c.id]);
  await svc('assistant_housekeeping', {});
  const [{ params }] = await db.sql('select params from assistant_pending where id = $1', [c.id]);
  assert.deepEqual(params, { redacted: true });
});
