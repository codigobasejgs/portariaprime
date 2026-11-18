// Evolução modular P0 (20261118000100/0200): catálogo e contratação de módulos, eventos de encomendas pelo outbox,
// visitantes com QR de uso único e gateway simulado. Condomínios A e B com a MESMA numeração de unidade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDb } from './harness.mjs';

const uuid = () => crypto.randomUUID();
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function setup() {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const owner = await db.createUser('owner@pp.invalid');
  await db.sql("insert into platform_admins (user_id, role) values ($1, 'owner')", [owner]);
  const sindA = await db.createUser('sa@pm.invalid'), sindB = await db.createUser('sb@pm.invalid');
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: `Cond ${slug}`, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sindA, 'pm-a', '11444777000161'), B = await prov(sindB, 'pm-b', '04252011000110');
  const unit = async (T) => (await db.sql("insert into units (tenant_id, block, label) values ($1, 'A', '101') returning id", [T]))[0].id;
  const uA = await unit(A), uB = await unit(B);
  const member = async (T, role, email, u = null) => {
    const id = await db.createUser(email);
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, status) values ($1,$2,$3,'active')", [T, id, role]);
    if (u) await db.sql("insert into unit_memberships (tenant_id, unit_id, user_id) values ($1,$2,$3)", [T, u, id]);
    return id;
  };
  const porA = await member(A, 'porteiro', 'pa@pm.invalid'), porB = await member(B, 'porteiro', 'pb@pm.invalid');
  const morA = await member(A, 'morador', 'ma@pm.invalid', uA), morB = await member(B, 'morador', 'mb@pm.invalid', uB);
  // Como o PostgREST: claims com login recente (amr) para ações sensíveis.
  const asRecent = async (uid, sql, params = []) => {
    await db.raw.exec('begin');
    try {
      await db.raw.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
        [uid, JSON.stringify({ sub: uid, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query(sql, params);
      await db.raw.exec('commit');
      return r.rows;
    } catch (e) { await db.raw.exec('rollback'); throw e; }
  };
  const setModule = (T, key, on, reason = 'Contrato piloto assinado') => db.rpc(owner, 'platform_module_set', { p_tenant: T, p_module: key, p_enabled: on, p_reason: reason });
  return { db, owner, sindA, sindB, A, B, uA, uB, porA, porB, morA, morB, asRecent, setModule };
}

test('módulos: encomendas ligado para todos; visitors só onde contratado; auditoria e idempotência', async () => {
  const { db, owner, sindA, sindB, A, B, morA, setModule } = await setup();
  try {
    const mods = (T, u) => db.rpc(u, 'tenant_modules', { p_tenant: T });
    const on = (list, k) => list.find((m) => m.key === k).enabled;
    assert.equal(on(await mods(A, sindA), 'parcels'), true, 'encomendas sem linha = ligado');
    assert.equal(on(await mods(A, sindA), 'visitors'), false);
    // Só owner da plataforma liga; síndico não.
    await assert.rejects(db.rpc(sindA, 'platform_module_set', { p_tenant: A, p_module: 'visitors', p_enabled: true, p_reason: 'quero ligar' }), /plataforma/);
    await assert.rejects(setModule(A, 'visitors', true, 'x'), /justificativa/);
    await assert.rejects(setModule(A, 'cctv', true), /não está disponível/, 'módulo sem implementação não liga');
    const r1 = await setModule(A, 'visitors', true);
    assert.deepEqual([r1.enabled, r1.version, r1.changed], [true, 1, true]);
    const r2 = await setModule(A, 'visitors', true);
    assert.deepEqual([r2.version, r2.changed], [1, false], 'repetir não cria versão');
    assert.equal(on(await mods(A, morA), 'visitors'), true);
    assert.equal(on(await mods(B, sindB), 'visitors'), false, 'B continua desligado');
    await assert.rejects(mods(A, sindB), /permissão/i, 'B não lê módulos de A');
    const audit = await db.sql('select count(*)::int n from tenant_module_audit where tenant_id = $1', [A]);
    assert.equal(audit[0].n, 1);
    await assert.rejects(db.sql('update tenant_module_audit set reason = $1', ['x']), /append-only|não pode|imut/i);
    const det = await db.rpc(owner, 'platform_tenant_modules', { p_tenant: A });
    assert.equal(det.audit.length, 1);
    // Tabelas sem acesso direto.
    for (const u of [sindA, morA]) {
      await assert.rejects(db.as(u, 'select * from tenant_module_entitlements'), /permission denied/);
      await assert.rejects(db.as(u, 'insert into tenant_module_entitlements (tenant_id, module_key, enabled, reason) values ($1, $2, true, $3)', [A, 'visitors', 'burlar']), /permission denied/);
    }
  } finally { await db.raw.close(); }
});

test('eventos de encomendas: recebimento e retirada pelas RPCs atuais geram 1 evento cada, sem PII; inbox idempotente', async () => {
  const { db, A, B, uA, uB, porA, porB } = await setup();
  try {
    await db.service("insert into event_consumers (key, description, event_types) values ('test.consumer', 'teste', array['parcel.received.v1','parcel.picked_up.v1','parcel.exception.v1'])");
    const recv = (who, T, u, key) => db.rpc(who, 'receive_package', { p_tenant: T, p_idempotency_key: key, p_unit: u, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    const pA = await recv(porA, A, uA, 'pm-key-a-0001');
    await recv(porA, A, uA, 'pm-key-a-0001');             // retry do cliente: mesma encomenda
    const pB = await recv(porB, B, uB, 'pm-key-b-0001');
    const evs = await db.sql("select tenant_id, event_type, aggregate_id, payload from domain_events where event_type like 'parcel.%' order by seq");
    assert.equal(evs.length, 2, 'retry não duplica evento');
    assert.deepEqual(evs.map((e) => [e.tenant_id, e.aggregate_id]), [[A, pA.id], [B, pB.id]]);
    const keys = Object.keys(evs[0].payload).sort();
    assert.deepEqual(keys, ['parcel_id', 'registered_via', 'status', 'unit_id'], 'payload mínimo, sem nome/telefone/foto');
    // Retirada pela baixa existente.
    await db.rpc(porA, 'resolve_package', { p_tenant: A, p_package: pA.id, p_status: 'DEVOLVIDA', p_reason: 'Devolvido ao remetente pela transportadora' });
    const types = (await db.sql('select event_type from domain_events where aggregate_id = $1 order by seq', [pA.id])).map((e) => e.event_type);
    assert.deepEqual(types, ['parcel.received.v1', 'parcel.exception.v1']);
    // Encomenda e histórico intactos.
    const [pk] = await db.sql('select status, idempotency_key from packages where id = $1', [pA.id]);
    assert.deepEqual([pk.status, pk.idempotency_key], ['DEVOLVIDA', 'pm-key-a-0001']);

    // Inbox: pull reserva, ack repetido é idempotente, falha volta com backoff, 6 falhas = dead-letter.
    const pull = () => db.service("select * from public.event_pull('test.consumer', 10)");
    const batch = await pull();
    assert.equal(batch.length, 3);
    assert.equal((await pull()).length, 0, 'reservado não é entregue de novo durante o lease');
    assert.equal((await db.service("select public.event_ack('test.consumer', $1, true) r", [batch[0].event_id]))[0].r, 'done');
    assert.equal((await db.service("select public.event_ack('test.consumer', $1, true) r", [batch[0].event_id]))[0].r, 'done', 'ack duplicado');
    assert.equal((await db.service("select public.event_ack('test.consumer', $1, false, 'worker caiu') r", [batch[1].event_id]))[0].r, 'retry');
    await db.sql("update event_deliveries set attempts = 6, status = 'leased' where event_id = $1", [batch[2].event_id]);
    assert.equal((await db.service("select public.event_ack('test.consumer', $1, false, 'erro') r", [batch[2].event_id]))[0].r, 'dead');
    // Falha simulada do worker: lease vencido volta para a fila (reprocessamento).
    await db.sql("update event_deliveries set next_attempt_at = now() - interval '1 minute' where event_id = $1", [batch[1].event_id]);
    assert.deepEqual((await pull()).map((e) => e.event_id), [batch[1].event_id]);
    await assert.rejects(db.service("select * from public.event_pull('nao.existe', 10)"), /Consumidor/);
    for (const u of [porA]) await assert.rejects(db.as(u, 'select * from domain_events'), /permission denied/);
  } finally { await db.raw.close(); }
});

test('visitantes: módulo por condomínio, QR de uso único/validade/revogação e isolamento A/B', async () => {
  const { db, A, B, uA, uB, porA, porB, morA, morB, setModule } = await setup();
  try {
    const create = (who, T, u, extra = {}) => db.rpc(who, 'visitor_pass_create', { p_tenant: T, p_unit: u, p_name: 'Carlos Visitante', ...extra });
    await assert.rejects(create(morA, A, uA), /não contratado/, 'desligado: API recusa mesmo com menu escondido');
    await setModule(A, 'visitors', true);
    await assert.rejects(create(morB, B, uB), /não contratado/, 'ligar em A não liga em B');
    await assert.rejects(create(morB, A, uA), /Sem permissão/, 'morador de B não convida para A');
    await assert.rejects(create(morA, A, uB), /Sem permissão/, 'unidade 101 de B não é a 101 de A');
    const pass = await create(morA, A, uA);
    assert.match(pass.qr, /^PV1\.[0-9a-f]{64}$/);
    assert.equal((await db.as(morA, 'select count(*)::int n from visitor_passes'))[0].n, 1);
    await assert.rejects(db.as(morA, 'select token_hash from visitor_passes'), /permission denied/, 'hash do QR fora do alcance');
    assert.equal((await db.as(morB, 'select count(*)::int n from visitor_passes'))[0].n, 0);
    await assert.rejects(db.rpc(porB, 'visitor_pass_lookup', { p_tenant: B, p_qr: pass.qr }), /não contratado|não reconhecido/);
    const look = await db.rpc(porA, 'visitor_pass_lookup', { p_tenant: A, p_qr: pass.qr });
    assert.equal(look.status, 'active');
    const key = uuid();
    const r1 = await db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: key, p_qr: pass.qr });
    assert.equal(r1.replayed, false);
    assert.equal((await db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: key, p_qr: pass.qr })).replayed, true, 'retry idempotente');
    await assert.rejects(db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_qr: pass.qr }), /já utilizado/, 'QR usado é negado');
    const notif = await db.as(morA, "select title from notifications where kind = 'visitor_arrived'");
    assert.equal(notif.length, 1, 'morador avisado pela caixa existente');
    // Revogado e expirado.
    const p2 = await create(morA, A, uA);
    await db.rpc(morA, 'visitor_pass_revoke', { p_tenant: A, p_pass: p2.id });
    await assert.rejects(db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_qr: p2.qr }), /revogado/);
    const p3 = await create(morA, A, uA, { p_valid_from: '2026-01-01T10:00:00Z', p_valid_until: '2026-01-01T12:00:00Z' });
    await assert.rejects(db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_qr: p3.qr }), /expirado/);
    // Manual exige quem autorizou; não abre portão (nenhum comando de acesso criado).
    await assert.rejects(db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Ana Prestadora', p_kind: 'prestador' }), /quem autorizou/);
    const m = await db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Ana Prestadora', p_kind: 'prestador', p_authorized_by: 'Morador por interfone' });
    await db.rpc(porA, 'visitor_check_out', { p_tenant: A, p_visit: m.id });
    assert.equal((await db.sql('select count(*)::int n from access_commands'))[0].n, 0);
    const types = (await db.sql("select event_type from domain_events where tenant_id = $1 and event_type like 'visitor.%'", [A])).map((e) => e.event_type);
    assert.ok(types.includes('visitor.invited.v1') && types.includes('visitor.arrived.v1') && types.includes('visitor.authorized.v1'));
    // Morador que saiu da unidade: convite dele deixa de valer.
    const p4 = await create(morA, A, uA);
    await db.sql("update unit_memberships set status = 'revoked' where user_id = $1", [morA]);
    await assert.rejects(db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_qr: p4.qr }), /não tem mais vínculo/);
    await db.sql("update unit_memberships set status = 'active' where user_id = $1", [morA]);
    // Desligar o módulo não apaga dados e ainda deixa registrar a SAÍDA de quem já entrou.
    const inside = await db.rpc(porA, 'visitor_check_in', { p_tenant: A, p_idempotency_key: uuid(), p_unit: uA, p_name: 'Dentro Ainda', p_authorized_by: 'Morador' });
    await setModule(A, 'visitors', false, 'Fim do piloto');
    assert.ok((await db.rpc(porA, 'visitor_check_out', { p_tenant: A, p_visit: inside.id })).checked_out_at, 'saída sem módulo');
    await assert.rejects(db.rpc(porB, 'visitor_check_out', { p_tenant: B, p_visit: inside.id }), /não encontrada/, 'B não fecha visita de A');
    assert.equal((await db.sql('select count(*)::int n from visitor_passes where tenant_id = $1', [A]))[0].n, 4);
    await assert.rejects(db.rpc(morA, 'visitor_list', { p_tenant: A }), /não contratado/);
    assert.equal((await db.as(morA, 'select count(*)::int n from visitor_passes'))[0].n, 0, 'RLS também respeita o módulo');
  } finally { await db.raw.close(); }
});

test('gateway simulado: pareamento, online/offline, comando assinado com TTL/sequência, replay e confirmação física', async () => {
  const { db, sindA, A, B, porA, porB, asRecent, setModule } = await setup();
  try {
    await assert.rejects(asRecent(sindA, "select public.gateway_create($1, 'Portaria', 'simulator') r", [A]), /não contratado/);
    await setModule(A, 'concierge', true);
    await assert.rejects(db.rpc(sindA, 'gateway_create', { p_tenant: A, p_name: 'Portaria' }), /Confirme sua senha/, 'ação sensível pede senha recente');
    await assert.rejects(asRecent(sindA, "select public.gateway_create($1, 'Portaria', 'linux') r", [A]), /pending_hardware/, 'P0: só simulador');
    const [{ r: gw }] = await asRecent(sindA, "select public.gateway_create($1, 'Portaria', 'simulator') r", [A]);
    const secret = 'f'.repeat(64);
    await assert.rejects(db.service("select public.gateway_pair('ERRADO1234', $1, 'sim-1')", [sha(secret)]), /inválido/);
    const paired = (await db.service("select public.gateway_pair($1, $2, 'sim-1') r", [gw.pair_code, sha(secret)]))[0].r;
    assert.equal(paired.tenant_id, A);
    await assert.rejects(db.service("select public.gateway_pair($1, $2, 'sim-1')", [gw.pair_code, sha('e'.repeat(64))]), /inválido/, 'código de uso único');
    const dev = uuid(), cam = uuid();
    const hb = (s = secret) => db.service('select public.gateway_heartbeat($1, now(), $2::jsonb) r', [sha(s), JSON.stringify([
      { id: dev, name: 'Portão social', device_type: 'access_point', driver: 'simulator', capabilities: ['pulse_open', 'read_state'], has_physical_sensor: false, state: 'online' },
      { id: cam, name: 'Câmera ONVIF', device_type: 'camera', driver: 'onvif', capabilities: ['live_video'], state: 'online' },
    ])]).then((r) => r[0].r);
    await hb();
    const devs = await db.sql('select id, driver, homologation_status from gateway_devices where tenant_id = $1', [A]);
    assert.deepEqual(devs.map((d) => [d.id, d.driver, d.homologation_status]), [[dev, 'simulator', 'simulated']], 'driver real não é aceito sem homologação');
    await assert.rejects(hb('0'.repeat(64)), /não autorizado/);
    // B não vê o gateway de A; porteiro de A vê.
    assert.equal((await db.as(porB, 'select count(*)::int n from gateways'))[0].n, 0);
    assert.equal((await db.as(porA, 'select count(*)::int n from gateway_devices'))[0].n, 1);
    await assert.rejects(db.as(porA, 'select secret_hash from gateways'), /permission denied/);

    // Comando: porteiro de B não comanda dispositivo de A.
    await assert.rejects(asRecent(porB, "select public.access_command_request($1, $2, 'pulse_open', 'Teste de outro condomínio') r", [B, dev]), /não contratado|não encontrado/);
    const [{ r: cmd }] = await asRecent(porA, "select public.access_command_request($1, $2, 'pulse_open', 'Visitante autorizado pelo morador') r", [A, dev]);
    assert.equal(cmd.simulated, true);
    const pend = (await hb()).commands;
    assert.equal(pend.length, 1);
    assert.equal((await hb()).commands.length, 0, 'comando entregue uma vez só (não reenvia a cada heartbeat)');
    // Item malformado no inventário é ignorado, não derruba o heartbeat.
    await db.service('select public.gateway_heartbeat($1, now(), $2::jsonb)', [sha(secret), JSON.stringify([{ id: uuid(), device_type: 'sensor', driver: 'simulator', has_physical_sensor: 'talvez', capabilities: 'x' }])]);
    const res = (seq, nonce, result = 'physically_confirmed', s = secret) => db.service('select public.gateway_command_result($1, $2, $3, $4, $5) r', [sha(s), cmd.id, seq, nonce, result]).then((r) => r[0].r);
    assert.equal(await res(pend[0].seq, 'a'.repeat(32)), 'rejected_signature', 'nonce errado negado');
    assert.equal(await res(pend[0].seq + 1, pend[0].nonce), 'rejected_signature', 'sequência errada negada');
    // Sem sensor: "confirmado" pelo gateway vira unknown (nunca sucesso físico fictício).
    assert.equal(await res(pend[0].seq, pend[0].nonce), 'unknown');
    assert.equal(await res(pend[0].seq, pend[0].nonce), 'rejected_replay', 'replay negado');
    const audit = await db.sql("select data->>'why' w from audit_logs where action = 'access.command_rejected' order by id");
    assert.deepEqual(audit.map((a) => a.w), ['signature', 'signature', 'replay']);
    // TTL vencido.
    const [{ r: c2 }] = await asRecent(porA, "select public.access_command_request($1, $2, 'read_state', 'Conferir estado do portão') r", [A, dev]);
    const p2 = (await hb()).commands[0];
    await db.sql("update access_commands set expires_at = now() - interval '1 second' where id = $1", [c2.id]);
    assert.equal((await db.service('select public.gateway_command_result($1, $2, $3, $4, $5) r', [sha(secret), c2.id, p2.seq, p2.nonce, 'acknowledged']))[0].r, 'expired');
    const [late] = await db.sql('select status, result_detail from access_commands where id = $1', [c2.id]);
    assert.equal(late.status, 'unknown', 'resultado tardio fica como desconhecido (pode ter executado)');
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action = 'access.command_late_result'"))[0].n, 1);
    // Comando de gateway que não responde vence pelo sweep.
    const [{ r: c3 }] = await asRecent(porA, "select public.access_command_request($1, $2, 'read_state', 'Conferir de novo o portão') r", [A, dev]);
    await db.sql("update access_commands set expires_at = now() - interval '1 second' where id = $1", [c3.id]);
    await db.service('select public.gateway_sweep()');
    assert.equal((await db.sql('select status from access_commands where id = $1', [c3.id]))[0].status, 'expired');
    // Offline e revogação.
    await db.sql("update gateways set last_seen_at = now() - interval '5 minutes' where tenant_id = $1", [A]);
    assert.equal((await db.service('select public.gateway_sweep() r'))[0].r, 1);
    assert.equal((await db.sql('select status from gateways where tenant_id = $1', [A]))[0].status, 'offline');
    await asRecent(sindA, 'select public.gateway_revoke($1, $2)', [A, gw.id]);
    await assert.rejects(hb(), /não autorizado/, 'credencial revogada');
    const st = (await db.sql("select event_type, payload->>'status' s from domain_events where event_type = 'gateway.status_changed.v1' order by seq")).map((e) => e.s);
    assert.deepEqual(st, ['online', 'offline', 'revoked']);
    // Trilha de módulos: imutável para UPDATE, mas não bloqueia DELETE (a cascata de uma exclusão de condomínio/LGPD
    // não pode travar nela; audit_logs antigo tem regra própria, inalterada).
    await db.service("insert into tenant_module_audit (tenant_id, module_key, after, reason) values ($1, 'visitors', '{}', 'teste de exclusão')", [B]);
    await db.sql('delete from tenant_module_audit where tenant_id = $1', [B]);
    await assert.rejects(db.sql("update tenant_module_audit set reason = 'x' where tenant_id = $1", [A]), /append-only|UPDATE bloqueado/);
  } finally { await db.raw.close(); }
});

test('painel integrado: encomendas + visitas + gateways só com concierge; recebimento não autoriza portão', async () => {
  const { db, A, B, uA, porA, porB, setModule } = await setup();
  try {
    await assert.rejects(db.rpc(porA, 'concierge_overview', { p_tenant: A }), /não contratado/);
    await setModule(A, 'concierge', true); await setModule(A, 'visitors', true);
    await db.rpc(porA, 'receive_package', { p_tenant: A, p_idempotency_key: 'pm-ov-0001', p_unit: uA, p_tracking: null, p_carrier: 'Amazon', p_courier: 'Entregador Teste' });
    const ov = await db.rpc(porA, 'concierge_overview', { p_tenant: A });
    assert.equal(ov.parcels.waiting, 1);
    assert.equal(ov.visitors.inside, 0);
    assert.deepEqual(ov.gateways, []);
    await assert.rejects(db.rpc(porB, 'concierge_overview', { p_tenant: A }), /permissão/i);
    assert.equal((await db.sql('select count(*)::int n from access_commands'))[0].n, 0);
  } finally { await db.raw.close(); }
});
