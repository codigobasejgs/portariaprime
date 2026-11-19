// P1 Portaria e Visitantes (20261119000100): configuração por condomínio, cadastro sem duplicar pessoa, bloqueio,
// entrada completa, vínculo com encomendas sem duplicar, ocorrências, histórico unificado, pontos de acesso
// declarativos e indicadores do síndico. Condomínios A e B com a mesma unidade "A 101".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const uuid = () => crypto.randomUUID();

async function setup() {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const owner = await db.createUser('owner@p1.invalid');
  await db.sql("insert into platform_admins (user_id, role) values ($1, 'owner')", [owner]);
  const sindA = await db.createUser('sa@p1.invalid'), sindB = await db.createUser('sb@p1.invalid');
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: `Cond ${slug}`, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sindA, 'p1-a', '11444777000161'), B = await prov(sindB, 'p1-b', '04252011000110');
  const unit = async (T) => (await db.sql("insert into units (tenant_id, block, label) values ($1, 'A', '101') returning id", [T]))[0].id;
  const uA = await unit(A), uB = await unit(B);
  const member = async (T, role, email, u = null) => {
    const id = await db.createUser(email);
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, status) values ($1,$2,$3,'active')", [T, id, role]);
    if (u) await db.sql('insert into unit_memberships (tenant_id, unit_id, user_id) values ($1,$2,$3)', [T, u, id]);
    return id;
  };
  const porA = await member(A, 'porteiro', 'pa@p1.invalid'), porB = await member(B, 'porteiro', 'pb@p1.invalid');
  const morA = await member(A, 'morador', 'ma@p1.invalid', uA);
  const on = (T, key) => db.rpc(owner, 'platform_module_set', { p_tenant: T, p_module: key, p_enabled: true, p_reason: 'Piloto P1 contratado' });
  for (const k of ['visitors', 'concierge', 'incident']) await on(A, k);
  return { db, owner, sindA, sindB, A, B, uA, uB, porA, porB, morA, on };
}

test('configuração por condomínio limita convites; morador pode ser impedido de convidar', async () => {
  const { db, sindA, A, uA, porA, morA } = await setup();
  try {
    const cfg = (c) => db.rpc(sindA, 'concierge_settings_save', { p_tenant: A, p_cfg: JSON.stringify(c) });
    await assert.rejects(db.rpc(porA, 'concierge_settings_save', { p_tenant: A, p_cfg: '{}' }), /configurações/);
    await assert.rejects(cfg({ pass_max_days: 99 }), /fora do permitido/);
    await cfg({ pass_default_hours: 4, pass_max_days: 2, pass_max_uses: 3, require_document: true });
    const create = (who, extra = {}) => db.rpc(who, 'visitor_pass_create', { p_tenant: A, p_unit: uA, p_name: 'Lia Visita', p_document_last4: '1234', ...extra });
    const p = await create(morA);
    assert.equal(Math.round((Date.parse(p.valid_until) - Date.parse(p.valid_from)) / 3600_000), 4, 'validade padrão do condomínio');
    await assert.rejects(create(morA, { p_valid_until: new Date(Date.now() + 5 * 86400_000).toISOString() }), /Validade máxima/);
    await assert.rejects(create(morA, { p_max_uses: 4 }), /Máximo de 3/);
    await assert.rejects(create(morA, { p_document_last4: null }), /exige os 4 últimos/);
    await cfg({ residents_can_invite: false });
    assert.equal((await db.rpc(morA, 'concierge_settings_get', { p_tenant: A })).pass_max_days, 2, 'salvar parcial não zera o resto');
    await assert.rejects(cfg({ pass_default_hours: 72 }), /fora do permitido/, 'validade padrão maior que a máxima');
    await assert.rejects(db.rpc(sindA, 'concierge_settings_save', { p_tenant: A, p_cfg: null }), /inválida/);
    await assert.rejects(create(morA), /feitos pela portaria/);
    assert.ok((await create(porA)).qr, 'portaria continua convidando');
    assert.equal((await db.rpc(morA, 'concierge_settings_get', { p_tenant: A })).residents_can_invite, false);
  } finally { await db.raw.close(); }
});

test('cadastro sem duplicar pessoa, bloqueio com entrada negada registrada e isolamento A/B', async () => {
  const { db, sindA, A, B, uA, porA, porB } = await setup();
  try {
    const entry = (extra) => db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_authorized_by: 'Morador por interfone', ...extra });
    const e1 = await entry({ p_name: 'José  da Silva', p_kind: 'prestador', p_document_last4: '9876', p_company: 'Net Fibra' });
    const e2 = await entry({ p_name: 'JOSÉ DA SILVA', p_kind: 'prestador', p_document_last4: '9876' });
    assert.equal(e1.profile_id, e2.profile_id, 'mesma pessoa = mesmo cadastro');
    const homonimo = await entry({ p_name: 'José da Silva', p_document_last4: '1111' });
    assert.notEqual(homonimo.profile_id, e1.profile_id, 'homônimo com documento diferente não é a mesma pessoa');
    const found = await db.rpc(porA, 'visitor_profile_search', { p_tenant: A, p_query: 'jose silva' });
    assert.equal(found.length, 2);
    assert.equal(found.find((f) => f.id === e1.profile_id).visits, 2);
    assert.equal((await db.rpc(porA, 'visitor_profile_search', { p_tenant: A, p_query: 'net' })).length, 1, 'busca por empresa');
    await assert.rejects(db.rpc(porB, 'visitor_profile_search', { p_tenant: A, p_query: 'jose' }), /não contratado|permissão/i);

    // Bloqueio: só 'approve'; entrada negada fica no histórico sem consumir convite.
    await assert.rejects(db.rpc(porA, 'visitor_profile_block', { p_tenant: A, p_profile: e1.profile_id, p_blocked: true, p_reason: 'Furto na unidade 202' }), /aprova/);
    await db.sql("update tenant_memberships set permissions = '{approve,settings}' where user_id = $1", [sindA]);
    await db.rpc(sindA, 'visitor_profile_block', { p_tenant: A, p_profile: e1.profile_id, p_blocked: true, p_reason: 'Furto na unidade 202' });
    const denied = await entry({ p_profile: e1.profile_id });
    assert.deepEqual([denied.denied, denied.reason], [true, 'Furto na unidade 202']);
    const [v] = await db.sql('select denied, checked_out_at is not null closed from visitor_visits where id = $1', [denied.id]);
    assert.deepEqual([v.denied, v.closed], [true, true]);
    assert.equal((await db.sql("select count(*)::int n from domain_events where event_type = 'access.denied.v1'"))[0].n, 1);
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action = 'visitor.blocked'"))[0].n, 1);
    // Convite para pessoa bloqueada: não consome o QR.
    const pass = await db.rpc(porA, 'visitor_pass_create', { p_tenant: A, p_unit: uA, p_name: 'José da Silva', p_document_last4: '9876' });
    const viaQr = await db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_qr: pass.qr });
    assert.equal(viaQr.denied, true);
    assert.equal((await db.sql('select uses from visitor_passes where id = $1', [pass.id]))[0].uses, 0);
    // Nome igual ao de pessoa bloqueada (outro documento, ou sem): não passa sem a equipe confirmar, e a confirmação é auditada.
    await assert.rejects(entry({ p_name: 'José da Silva' }), /pessoa bloqueada com este nome/);
    const pass2 = await db.rpc(porA, 'visitor_pass_create', { p_tenant: A, p_unit: uA, p_name: 'Jose da Silva' });
    await assert.rejects(db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_qr: pass2.qr }), /pessoa bloqueada com este nome/,
      'convite com o mesmo nome não contorna o bloqueio');
    const ok = await entry({ p_name: 'José da Silva', p_confirm_distinct: true });
    assert.equal(ok.denied, false);
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action = 'visitor.namesake_confirmed'"))[0].n, 1);
    // Motivo do bloqueio não vai para a linha da visita (que o morador da unidade pode ler).
    assert.equal((await db.sql('select reason from visitor_visits where id = $1', [denied.id]))[0].reason, 'Entrada não autorizada (cadastro bloqueado)');
    const morA = (await db.sql("select user_id from unit_memberships where unit_id = $1 limit 1", [uA]))[0]?.user_id;
    assert.ok(morA, 'morador da unidade existe no setup');
    await assert.rejects(db.as(morA, 'select reason from visitor_visits'), /permission denied/, 'morador não lê motivo/observação');
    const mine = await db.rpc(morA, 'visitor_list', { p_tenant: A });
    assert.ok(mine.visits.length > 0 && !mine.visits.some((x) => x.id === denied.id), 'tentativa negada não aparece como visita para o morador');
    // Tabela de cadastros sem acesso direto.
    await assert.rejects(db.as(porA, 'select * from visitor_profiles'), /permission denied/);
    // Assinatura antiga do P0 continua funcionando (delegação).
    const old = await db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Cliente Antigo', p_authorized_by: 'Síndico' });
    assert.equal(old.denied, false);
    void B;
  } finally { await db.raw.close(); }
});

test('entrega: entregador de Encomendas vira a mesma pessoa e as encomendas são vinculadas sem duplicar', async () => {
  const { db, A, B, uA, uB, porA, porB, on } = await setup();
  try {
    const courier = (await db.sql("insert into couriers (tenant_id, full_name) values ($1, 'Carlos Entregador') returning id", [A]))[0].id;
    const recv = (key) => db.rpc(porA, 'receive_and_store', { p_tenant: A, p_idempotency_key: key, p_unit: uA, p_tracking: null, p_carrier: 'Loggi',
      p_recipient: null, p_notes: null, p_storage_location: null, p_courier: 'Carlos Entregador' });
    const v = await db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Carlos Entregador', p_kind: 'entrega',
      p_authorized_by: 'Portaria (entrega)', p_courier: courier });
    const v2 = await db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Outro Nome', p_kind: 'entrega',
      p_authorized_by: 'Portaria (entrega)', p_courier: courier });
    assert.equal(v.profile_id, v2.profile_id, 'mesmo entregador = mesmo cadastro, mesmo com nome digitado diferente');
    const p1 = await recv('p1-lote-0001'), p2 = await recv('p1-lote-0002');
    const before = (await db.sql('select count(*)::int n from packages where tenant_id = $1', [A]))[0].n;
    const cand = await db.rpc(porA, 'visit_parcel_candidates', { p_tenant: A, p_visit: v.id });
    assert.deepEqual(cand.map((c) => c.id).sort(), [p1.id, p2.id].sort());
    assert.equal((await db.rpc(porA, 'visit_link_parcels', { p_tenant: A, p_visit: v.id, p_packages: [p1.id, p2.id] })).linked, 2);
    assert.equal((await db.rpc(porA, 'visit_link_parcels', { p_tenant: A, p_visit: v.id, p_packages: [p1.id] })).linked, 0, 'idempotente');
    assert.equal((await db.rpc(porA, 'visit_link_parcels', { p_tenant: A, p_visit: v2.id, p_packages: [p1.id] })).linked, 0, 'encomenda só em uma visita');
    assert.equal((await db.sql('select count(*)::int n from packages where tenant_id = $1', [A]))[0].n, before, 'vincular não cria encomenda');
    // Visitante comum não vincula encomenda; B não vincula a visita de A nem usa encomenda de A.
    const comum = await db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Visita Comum', p_authorized_by: 'Morador' });
    await assert.rejects(db.rpc(porA, 'visit_link_parcels', { p_tenant: A, p_visit: comum.id, p_packages: [p1.id] }), /entrega não encontrada/);
    for (const k of ['visitors', 'concierge']) await on(B, k);
    const vb = await db.rpc(porB, 'visitor_entry', { p_tenant: B, p_idempotency_key: uuid(), p_unit: uB, p_name: 'Entregador B', p_kind: 'entrega', p_authorized_by: 'Portaria' });
    assert.equal((await db.rpc(porB, 'visit_link_parcels', { p_tenant: B, p_visit: vb.id, p_packages: [p2.id] })).linked, 0, 'encomenda de A não entra em B');
    await assert.rejects(db.rpc(porB, 'visit_link_parcels', { p_tenant: B, p_visit: v.id, p_packages: [] }), /não encontrada/);
    await assert.rejects(db.rpc(porB, 'visitor_entry', { p_tenant: B, p_idempotency_key: uuid(), p_unit: uB, p_name: 'Carlos Entregador', p_kind: 'entrega', p_authorized_by: 'Portaria', p_courier: courier }),
      /Entregador não encontrado/, 'entregador de A não existe em B');
    // Entrega não avisa morador como "visitante" (o aviso da encomenda já sai pelo fluxo de Encomendas); visita comum avisa.
    const arrived = (await db.sql("select body from notifications where kind = 'visitor_arrived' and tenant_id = $1", [A])).map((n) => n.body);
    assert.ok(arrived.some((b) => b.startsWith('Visita Comum')));
    assert.ok(!arrived.some((b) => b.startsWith('Carlos Entregador')));
  } finally { await db.raw.close(); }
});

test('ocorrências: módulo próprio, idempotência, encerramento, alerta de gravidade alta e isolamento', async () => {
  const { db, owner, sindA, A, B, uA, porA, porB } = await setup();
  try {
    const key = uuid();
    const i = await db.rpc(porA, 'incident_create', { p_tenant: A, p_idempotency_key: key, p_category: 'seguranca', p_title: 'Portão da garagem aberto', p_severity: 'alta', p_unit: uA });
    assert.equal((await db.rpc(porA, 'incident_create', { p_tenant: A, p_idempotency_key: key, p_category: 'seguranca', p_title: 'Portão da garagem aberto' })).replayed, true);
    assert.equal((await db.as(sindA, "select count(*)::int n from notifications where kind = 'incident'"))[0].n, 1, 'síndico avisado (alta)');
    await assert.rejects(db.rpc(porA, 'incident_create', { p_tenant: A, p_idempotency_key: uuid(), p_category: 'inventada', p_title: 'xxx' }), /inválidos/);
    await assert.rejects(db.rpc(porB, 'incident_create', { p_tenant: B, p_idempotency_key: uuid(), p_category: 'outro', p_title: 'Teste B' }), /não contratado/);
    await assert.rejects(db.rpc(porB, 'incident_list', { p_tenant: A }), /permissão|não contratado/i);
    assert.equal((await db.rpc(porA, 'incident_list', { p_tenant: A, p_status: 'aberta' })).length, 1);
    await assert.rejects(db.rpc(porA, 'incident_close', { p_tenant: A, p_incident: i.id, p_resolution: '' }), /Descreva/);
    await db.rpc(porA, 'incident_close', { p_tenant: A, p_incident: i.id, p_resolution: 'Portão fechado e manutenção chamada' });
    await assert.rejects(db.rpc(porA, 'incident_close', { p_tenant: A, p_incident: i.id, p_resolution: 'de novo' }), /já encerrada/);
    await assert.rejects(db.as(porA, 'select * from incidents'), /permission denied/);
    void owner;
  } finally { await db.raw.close(); }
});

test('histórico unificado: encomendas + visitas + ocorrências só do condomínio; indicadores do síndico', async () => {
  const { db, sindA, sindB, A, uA, porA, porB } = await setup();
  try {
    await db.rpc(porA, 'receive_and_store', { p_tenant: A, p_idempotency_key: 'p1-tl-0001', p_unit: uA, p_tracking: 'TL1', p_carrier: 'Correios',
      p_recipient: null, p_notes: null, p_storage_location: null, p_courier: 'Entregador Teste' });
    const v = await db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Paula Visita', p_authorized_by: 'Morador' });
    await db.rpc(porA, 'visitor_check_out', { p_tenant: A, p_visit: v.id });
    await db.rpc(porA, 'incident_create', { p_tenant: A, p_idempotency_key: uuid(), p_category: 'recado', p_title: 'Chave deixada na portaria' });
    const tl = await db.rpc(porA, 'portaria_timeline', { p_tenant: A });
    assert.deepEqual([...new Set(tl.map((e) => e.type))].sort(), ['incident', 'parcel_received', 'visit_in', 'visit_out']);
    assert.ok(tl.every((e, i) => i === 0 || e.at <= tl[i - 1].at), 'mais recente primeiro');
    assert.equal((await db.rpc(porA, 'portaria_timeline', { p_tenant: A, p_unit: uA })).length, tl.length - 1, 'filtro por unidade (ocorrência sem unidade sai)');
    await assert.rejects(db.rpc(porB, 'portaria_timeline', { p_tenant: A }), /permissão/i);
    await assert.rejects(db.rpc(porA, 'portaria_timeline', { p_tenant: A, p_from: '2026-01-01T00:00:00Z', p_to: '2026-12-31T00:00:00Z' }), /93 dias/);
    const k = await db.rpc(sindA, 'concierge_kpis', { p_tenant: A });
    assert.deepEqual([k.visits, k.denied, k.open_incidents], [1, 0, 1]);
    await assert.rejects(db.rpc(porA, 'concierge_kpis', { p_tenant: A }), /permissão/i, 'indicadores só do síndico');
    await assert.rejects(db.rpc(sindB, 'concierge_kpis', { p_tenant: A }), /permissão/i);
  } finally { await db.raw.close(); }
});

test('pontos de acesso: só cadastro, estado honesto, nenhum comando; recebimento não abre portão', async () => {
  const { db, sindA, A, uA, porA } = await setup();
  try {
    await db.sql("update tenant_memberships set permissions = '{settings}' where user_id = $1", [sindA]);
    await assert.rejects(db.rpc(porA, 'access_point_save', { p_tenant: A, p_id: null, p_name: 'Portão social', p_kind: 'portao_pedestre' }), /configurações/);
    const ap = await db.rpc(sindA, 'access_point_save', { p_tenant: A, p_id: null, p_name: 'Portão social', p_kind: 'portao_pedestre', p_location: 'Entrada principal' });
    await db.rpc(sindA, 'access_point_save', { p_tenant: A, p_id: null, p_name: 'Câmera da guarita', p_kind: 'camera' });
    const list = await db.rpc(porA, 'access_points_list', { p_tenant: A });
    assert.deepEqual(list.map((x) => x.status), ['not_installed', 'not_installed'], 'sem equipamento: não instalado (nunca online)');
    await db.rpc(sindA, 'access_point_delete', { p_tenant: A, p_id: ap.id });
    await db.rpc(porA, 'receive_and_store', { p_tenant: A, p_idempotency_key: 'p1-ap-0001', p_unit: uA, p_tracking: null, p_carrier: 'Amazon',
      p_recipient: null, p_notes: null, p_storage_location: null, p_courier: 'Entregador Teste' });
    await db.rpc(porA, 'visitor_entry', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Visita', p_authorized_by: 'Morador' });
    assert.equal((await db.sql('select count(*)::int n from access_commands'))[0].n, 0);
  } finally { await db.raw.close(); }
});
