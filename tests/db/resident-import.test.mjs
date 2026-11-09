// Pré-cadastro por planilha e convites em lote (migration 20261109000200): isolamento, unidade cadastrada nunca
// recebe convite, idempotência, token de uso único/expira, equipe e anon sem acesso, convite não aprova sozinho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const uuid = () => crypto.randomUUID();

async function setup() {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const sind = await db.createUser('s@ia.invalid', { name: 'Síndica IA' });
  const sindB = await db.createUser('s@ib.invalid', { name: 'Síndico IB' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: `Cond ${slug}`, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sind, 'imp-a', '11444777000161');
  const B = await prov(sindB, 'imp-b', '04252011000110');
  const unit = async (T, label) => (await db.sql("insert into units (tenant_id, block, label) values ($1,'1A',$2) returning id", [T, label]))[0].id;
  const u = {};
  for (const l of ['01', '02', '03', '04', '05', '06', '07']) u[l] = await unit(A, l);
  const b01 = await unit(B, '01');
  const port = await db.createUser('port@ia.invalid', { name: 'Porteiro IA' });
  await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'porteiro','{}','active')", [A, port]);
  const semAprov = await db.createUser('adm@ia.invalid', { name: 'Admin Sem' });
  await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'admin','{settings}','active')", [A, semAprov]);
  const term = await db.rpc(null, 'privacy_term_current', { p_slug: 'imp-a' });
  const requestAccess = async (email, name, unitLabel) => {
    const uid = await db.createUser(email, { name });
    const r = await db.rpc(uid, 'request_access', { p_slug: 'imp-a', p_full_name: name, p_phone: '11977776666', p_block: '1A', p_unit: unitLabel, p_privacy_hash: term.hash });
    return { uid, request: r.request_id };
  };
  // Fictícios. 01: morador com vínculo; 02: convite pendente; 03: pedido pendente; 04, 06, 07: livres com celular; 05: só e-mail.
  const rows = [
    { unit_id: u['01'], full_name: 'Ana Vinculada', phone: '11988880001' },
    { unit_id: u['02'], full_name: 'Bruno Convidado', phone: '11988880002' },
    { unit_id: u['03'], full_name: 'Carla Pedido', phone: '11988880003' },
    { unit_id: u['04'], full_name: 'Davi Livre', phone: '(11) 98888-0004', email: 'davi@exemplo.test', kind: 'morador' },
    { unit_id: u['05'], full_name: 'Edu SoEmail', email: 'EDU@exemplo.test' },
    { unit_id: u['06'], full_name: 'Fabi Livre', phone: '11988880006' },
    { unit_id: u['06'], full_name: 'Gil Sem Contato' },
    { unit_id: u['07'], full_name: 'Hugo Livre', phone: '11988880007' },
  ];
  return { db, sind, sindB, port, semAprov, A, B, u, b01, rows, requestAccess };
}

const jobs = (db, T) => db.service(`select id, recipient, ref_id, payload, next_attempt_at, status from notification_jobs
  where tenant_id = $1 and event = 'resident_invite' order by next_attempt_at, ref_id`, [T]);

test('autorização, isolamento e acesso da equipe/anon', async () => {
  const { db, sind, sindB, port, semAprov, A, B, u, b01, rows } = await setup();
  try {
    // Unidade de outro condomínio e linha sem nome são ignoradas.
    const r = await db.rpc(sind, 'resident_import_save', { p_tenant: A, p_rows: JSON.stringify([...rows, { unit_id: b01, full_name: 'Intrusa B' }, { unit_id: u['01'], full_name: ' ' }]), p_stats: '{"linhas":10}' });
    assert.deepEqual([r.inserted, r.updated, r.skipped], [8, 0, 2]);
    const list = await db.rpc(sind, 'resident_import_list', { p_tenant: A });
    assert.equal(list.entries.length, 8);
    const davi = list.entries.find((e) => e.full_name === 'Davi Livre');
    assert.deepEqual([davi.phone, davi.email, davi.status], ['+5511988880004', 'davi@exemplo.test', 'pending']);
    assert.equal(list.entries.find((e) => e.full_name === 'Edu SoEmail').email, 'edu@exemplo.test');
    // Síndico B não vê nem grava em A; porteiro e admin sem "approve" também não.
    for (const who of [sindB, port, semAprov]) {
      await assert.rejects(db.rpc(who, 'resident_import_list', { p_tenant: A }), /Somente quem aprova/);
      await assert.rejects(db.rpc(who, 'resident_import_save', { p_tenant: A, p_rows: JSON.stringify(rows) }), /Somente quem aprova/);
      await assert.rejects(db.rpc(who, 'resident_invite_preview', { p_tenant: A, p_channel: 'whatsapp' }), /Somente quem aprova/);
      await assert.rejects(db.rpc(who, 'resident_invite_send', { p_tenant: A }), /Somente quem aprova/);
      await assert.rejects(db.rpc(who, 'resident_import_delete', { p_tenant: A }), /Somente quem aprova/);
    }
    // Síndico B gravando unidade de A no próprio condomínio: ignorado.
    const rb = await db.rpc(sindB, 'resident_import_save', { p_tenant: B, p_rows: JSON.stringify([{ unit_id: u['04'], full_name: 'Cruzada A' }]) });
    assert.deepEqual([rb.inserted, rb.skipped], [0, 1]);
    assert.equal((await db.rpc(sindB, 'resident_import_list', { p_tenant: B })).entries.length, 0);
    // Tabelas sem acesso direto (nem o síndico; nem o nome para a equipe).
    for (const who of [port, sind]) {
      await assert.rejects(db.as(who, 'select full_name from resident_import_entries'), /permission denied/);
      await assert.rejects(db.as(who, 'select stats from resident_import_batches'), /permission denied/);
    }
    await assert.rejects(db.as(null, 'select 1 from resident_import_entries'), /permission denied/);
    // Jobs de convite fora do SELECT direto da equipe (celular + token).
    await db.rpc(sind, 'resident_invite_send', { p_tenant: A, p_channel: 'whatsapp' });
    assert.ok((await jobs(db, A)).length > 0);
    for (const who of [port, sind]) {
      assert.equal((await db.as(who, "select count(*)::int n from notification_jobs where event = 'resident_invite'"))[0].n, 0);
    }
    // Anon: só o pré-preenchimento do link.
    const [g] = await db.sql(`select has_function_privilege('anon', 'public.resident_import_save(uuid,jsonb,jsonb)', 'execute') a,
      has_function_privilege('anon', 'public.resident_import_list(uuid)', 'execute') b,
      has_function_privilege('anon', 'public.resident_invite_send(uuid,text,int,int)', 'execute') c,
      has_function_privilege('anon', 'public.resident_invite_complete(text,text)', 'execute') d,
      has_function_privilege('anon', 'public.resident_invite_peek(text,text)', 'execute') e,
      has_function_privilege('authenticated', 'app.unit_registered(uuid,uuid)', 'execute') f`);
    assert.deepEqual([g.a, g.b, g.c, g.d, g.e, g.f], [false, false, false, false, true, false]);
    // Nenhuma conta, vínculo ou contato criado pela importação.
    const [n] = await db.sql(`select (select count(*) from unit_memberships where tenant_id = $1)::int um,
      (select count(*) from resident_contacts where tenant_id = $1)::int rc,
      (select count(*) from tenant_memberships where tenant_id = $1 and role = 'morador')::int tm`, [A]);
    assert.deepEqual([n.um, n.rc, n.tm], [0, 0, 0]);
  } finally { await db.raw.close(); }
});

test('unidade com cadastro nunca recebe convite; limite, escalonamento e idempotência', async () => {
  const { db, sind, A, u, rows, requestAccess } = await setup();
  try {
    // 01: vínculo via convite aceito; 02: convite pendente; 03: pedido pendente.
    const ana = await db.createUser('ana@ia.invalid', { name: 'Ana Vinculada' });
    const inv = await db.rpc(sind, 'create_invitation', { p_tenant: A, p_email: 'ana@ia.invalid', p_role: 'morador', p_unit: u['01'], p_permissions: '{}' });
    await db.rpc(ana, 'accept_invitation', { p_token: inv.token });
    await db.rpc(sind, 'create_invitation', { p_tenant: A, p_email: 'bruno@ia.invalid', p_role: 'morador', p_unit: u['02'], p_permissions: '{}' });
    await requestAccess('carla@ia.invalid', 'Carla Pedido', '03');
    await db.rpc(sind, 'resident_import_save', { p_tenant: A, p_rows: JSON.stringify(rows) });

    const pv = await db.rpc(sind, 'resident_invite_preview', { p_tenant: A, p_channel: 'whatsapp', p_limit: 1 });
    assert.deepEqual([pv.units, pv.eligible, pv.will_send, pv.remaining], [7, 3, 1, 2]);
    assert.deepEqual(pv.excluded, { unidade_cadastrada: 3, sem_contato: 1 });
    assert.equal(pv.left_out.length, 4);
    const pe = await db.rpc(sind, 'resident_invite_preview', { p_tenant: A, p_channel: 'email' });
    assert.deepEqual([pe.eligible, pe.excluded.sem_contato], [2, 2], 'e-mail: só 04 e 05');

    const s1 = await db.rpc(sind, 'resident_invite_send', { p_tenant: A, p_channel: 'whatsapp', p_limit: 1 });
    assert.deepEqual([s1.queued, s1.remaining, s1.no_contact], [1, 2, 1]);
    const s2 = await db.rpc(sind, 'resident_invite_send', { p_tenant: A, p_channel: 'whatsapp', p_limit: 50, p_interval_s: 30 });
    assert.deepEqual([s2.queued, s2.remaining], [2, 0]);
    const s3 = await db.rpc(sind, 'resident_invite_send', { p_tenant: A, p_channel: 'whatsapp' });
    assert.equal(s3.queued, 0, 'reenviar não duplica');
    const js = await jobs(db, A);
    assert.equal(js.length, 3);
    assert.deepEqual(js.map((j) => j.recipient).sort(), ['+5511988880004', '+5511988880006', '+5511988880007'], 'nenhum job para 01/02/03; 06 só uma pessoa');
    assert.ok(js.every((j) => /^[0-9a-f]{64}$/.test(j.payload.token)));
    const lot = js.filter((j) => j.recipient !== js[0].recipient).map((j) => new Date(j.next_attempt_at).getTime()).sort();
    assert.equal(lot[1] - lot[0], 30_000, 'escalonado pelo intervalo');
    const st = Object.fromEntries((await db.rpc(sind, 'resident_import_list', { p_tenant: A })).entries.map((e) => [e.full_name, e.status]));
    assert.deepEqual([st['Davi Livre'], st['Fabi Livre'], st['Gil Sem Contato'], st['Edu SoEmail'], st['Ana Vinculada']],
      ['queued', 'queued', 'pending', 'no_contact', 'pending']);

    // Unidade ganhou cadastro depois de enfileirar: o worker não envia (revalidação).
    const j7 = js.find((j) => j.recipient === '+5511988880007');
    assert.equal((await db.service('select public.notification_is_authorized($1) ok', [j7.id]))[0].ok, true);
    await db.rpc(sind, 'create_invitation', { p_tenant: A, p_email: 'hugo@ia.invalid', p_role: 'morador', p_unit: u['07'], p_permissions: '{}' });
    assert.equal((await db.service('select public.notification_is_authorized($1) ok', [j7.id]))[0].ok, false);
    // Inserção direta no outbox para unidade com cadastro: descartada pelo guard.
    const e1 = (await db.service("select id from resident_import_entries where full_name = 'Ana Vinculada'"))[0].id;
    await db.sql("update resident_import_entries set status = 'queued', invite_count = 9, token_expires_at = now() + interval '1 day' where id = $1", [e1]);
    await db.service(`insert into notification_jobs (tenant_id, event, channel, recipient, ref_id) values ($1, 'resident_invite', 'whatsapp', '+5511988880001', $2)`, [A, `${e1}:9`]);
    assert.equal((await jobs(db, A)).length, 3);

    // Envio descartado (sem canal): volta a pendente e pode ser convidado de novo, sem duplicar o job antigo.
    const j6 = js.find((j) => j.recipient === '+5511988880006');
    await db.service("select public.complete_notification_job($1, 'disabled', null, 'sem canal', false)", [j6.id]);
    assert.equal((await db.service('select payload from notification_jobs where id = $1', [j6.id]))[0].payload.token, undefined, 'token sai do payload');
    const again = await db.rpc(sind, 'resident_invite_send', { p_tenant: A, p_channel: 'whatsapp' });
    assert.equal(again.queued, 1);
    assert.equal((await jobs(db, A)).filter((j) => j.recipient === '+5511988880006').length, 2);

    // Reimportar a planilha: nada duplica.
    const re = await db.rpc(sind, 'resident_import_save', { p_tenant: A, p_rows: JSON.stringify(rows) });
    assert.deepEqual([re.inserted, re.updated], [0, 8]);
    assert.equal((await db.rpc(sind, 'resident_import_list', { p_tenant: A })).entries.length, 8);
  } finally { await db.raw.close(); }
});

test('link do convite: pré-preenche, uso único, expira e não aprova', async () => {
  const { db, sind, sindB, A, u, rows, requestAccess } = await setup();
  try {
    db.setNow('2026-11-10T12:00:00Z');
    await db.rpc(sind, 'resident_import_save', { p_tenant: A, p_rows: JSON.stringify(rows) });
    await db.rpc(sind, 'resident_invite_send', { p_tenant: A, p_channel: 'whatsapp' });
    const js = await jobs(db, A);
    const tok = (phone) => js.find((j) => j.recipient === phone).payload.token;
    const t4 = tok('+5511988880004'), t6 = tok('+5511988880006');

    // Enviado: entrada vira sent_whatsapp, token sai do payload (o link continua valendo pelo hash).
    await db.service("select public.complete_notification_job($1, 'accepted', 'x', null, false)", [js.find((j) => j.recipient === '+5511988880004').id]);
    const peek = await db.rpc(null, 'resident_invite_peek', { p_slug: 'imp-a', p_token: t4 });
    assert.deepEqual([peek.full_name, peek.block, peek.label], ['Davi Livre', '1A', '04']);
    assert.equal(JSON.stringify(peek).includes('9888'), false, 'sem celular no pré-preenchimento');
    assert.equal(JSON.stringify(peek).includes('@'), false, 'sem e-mail no pré-preenchimento');
    assert.equal(await db.rpc(null, 'resident_invite_peek', { p_slug: 'imp-b', p_token: t4 }), null, 'token de A não vale em B');
    assert.equal(await db.rpc(null, 'resident_invite_peek', { p_slug: 'imp-a', p_token: 'f'.repeat(64) }), null);
    assert.equal((await db.rpc(sind, 'resident_import_list', { p_tenant: A })).entries.find((e) => e.full_name === 'Davi Livre').status, 'sent_whatsapp');

    // Concluir exige o pedido do próprio morador (cadastro + termo).
    const outsider = await db.createUser('x@ia.invalid', { name: 'Sem Pedido' });
    await assert.rejects(db.rpc(outsider, 'resident_invite_complete', { p_slug: 'imp-a', p_token: t4 }), /Envie o cadastro/);
    await assert.rejects(db.rpc(null, 'resident_invite_complete', { p_slug: 'imp-a', p_token: t4 }), /permission denied/);
    // Morador digitou unidade que não existe: o convite casa com a unidade importada.
    const davi = await requestAccess('davi@ia.invalid', 'Davi Livre', '99');
    const done = await db.rpc(davi.uid, 'resident_invite_complete', { p_slug: 'imp-a', p_token: t4 });
    assert.deepEqual([done.status, done.request_id], ['completed', davi.request]);
    const [req] = await db.sql('select status, unit_id from access_requests where id = $1', [davi.request]);
    assert.deepEqual([req.status, req.unit_id], ['pending', u['04']], 'continua pendente: o síndico aprova');
    assert.equal((await db.sql("select count(*)::int n from tenant_memberships where tenant_id = $1 and user_id = $2", [A, davi.uid]))[0].n, 0);
    // Uso único: some do pré-preenchimento; outro usuário não reaproveita; o mesmo recebe a mesma resposta.
    assert.equal(await db.rpc(null, 'resident_invite_peek', { p_slug: 'imp-a', p_token: t4 }), null);
    const other = await requestAccess('outro@ia.invalid', 'Outro Morador', '04');
    assert.equal((await db.rpc(other.uid, 'resident_invite_complete', { p_slug: 'imp-a', p_token: t4 })).status, 'invalid');
    assert.equal((await db.rpc(davi.uid, 'resident_invite_complete', { p_slug: 'imp-a', p_token: t4 })).status, 'completed');
    assert.equal((await db.rpc(sindB, 'resident_invite_preview', { p_tenant: (await db.sql("select id from tenants where slug='imp-b'"))[0].id })).units, 0);
    // Unidade 04 agora tem pedido pendente: fora de novos convites.
    const pv = await db.rpc(sind, 'resident_invite_preview', { p_tenant: A });
    assert.equal(pv.left_out.find((x) => x.full_name === 'Davi Livre').reason, 'unidade_cadastrada');

    // Expira em 30 dias.
    db.setNow('2026-12-11T12:00:00Z');
    assert.equal(await db.rpc(null, 'resident_invite_peek', { p_slug: 'imp-a', p_token: t6 }), null);
    const fabi = await requestAccess('fabi@ia.invalid', 'Fabi Livre', '06');
    assert.equal((await db.rpc(fabi.uid, 'resident_invite_complete', { p_slug: 'imp-a', p_token: t6 })).status, 'invalid');
    // Plano trata o expirado como reconvidável (unidade 06 tem pedido pendente agora, então fica de fora).
    assert.equal((await db.rpc(sind, 'resident_invite_preview', { p_tenant: A })).left_out.find((x) => x.unit.endsWith('06')).reason, 'unidade_cadastrada');
  } finally { await db.raw.close(); }
});

test('prestador/autorizado nunca elegível (mesmo por payload adulterado); dedupe por destinatário', async () => {
  const { db, sind, A, u } = await setup();
  try {
    // 04: prestador na unidade livre -> tipo_nao_morador; nunca convida.
    // 06 e 07: mesmo celular em duas unidades livres -> só a primeira recebe convite (destinatario_repetido na segunda).
    const rows = [
      { unit_id: u['04'], full_name: 'Diarista Rosa', phone: '11988880004', kind: 'prestador' },
      { unit_id: u['05'], full_name: 'Davi Unidade 05', phone: '11988880055', kind: 'morador' },
      { unit_id: u['06'], full_name: 'Fabi Unidade 06', phone: '11988880099', kind: 'morador' },
      { unit_id: u['07'], full_name: 'Gabi Unidade 07', phone: '11988880099', kind: 'morador' },
    ];
    await db.rpc(sind, 'resident_import_save', { p_tenant: A, p_rows: JSON.stringify(rows) });

    const pv = await db.rpc(sind, 'resident_invite_preview', { p_tenant: A, p_channel: 'whatsapp' });
    assert.deepEqual(pv.excluded, { tipo_nao_morador: 1, destinatario_repetido: 1 });
    assert.equal(pv.left_out.find((x) => x.full_name === 'Diarista Rosa').reason, 'tipo_nao_morador');
    assert.equal(pv.left_out.find((x) => x.full_name === 'Gabi Unidade 07').reason, 'destinatario_repetido');
    assert.equal(pv.eligible, 2, 'só 05 e 06');

    // Envio só gera jobs para 05 e 06.
    const snd = await db.rpc(sind, 'resident_invite_send', { p_tenant: A, p_channel: 'whatsapp' });
    assert.equal(snd.queued, 2);
    const js = await jobs(db, A);
    assert.deepEqual(js.map((j) => j.recipient).sort(), ['+5511988880055', '+5511988880099']);

    // Tentativa maliciosa: payload adulterado força inserção direta de job para o prestador.
    // O guard resident_invite_notification_allowed barra (sem permissão/dropped).
    const eRosa = (await db.service("select id from resident_import_entries where full_name = 'Diarista Rosa'"))[0].id;
    await db.sql("update resident_import_entries set status = 'queued', invite_count = 1, token_expires_at = now() + interval '1 day' where id = $1", [eRosa]);
    await db.service(`insert into notification_jobs (tenant_id, event, channel, recipient, ref_id) values ($1, 'resident_invite', 'whatsapp', '+5511988880004', $2)`, [A, `${eRosa}:1`]);
    assert.equal((await jobs(db, A)).length, 2, 'job do prestador descartado pelo guard');

    // Segundo job direto para o mesmo telefone (+5511988880099) apontando para a unidade 07: guard barra (dedupe).
    const eGabi = (await db.service("select id from resident_import_entries where full_name = 'Gabi Unidade 07'"))[0].id;
    await db.sql("update resident_import_entries set status = 'queued', invite_count = 1, token_expires_at = now() + interval '1 day' where id = $1", [eGabi]);
    await db.service(`insert into notification_jobs (tenant_id, event, channel, recipient, ref_id) values ($1, 'resident_invite', 'whatsapp', '+5511988880099', $2)`, [A, `${eGabi}:1`]);
    assert.equal((await jobs(db, A)).length, 2, 'segundo job para o mesmo número descartado');
  } finally { await db.raw.close(); }
});

