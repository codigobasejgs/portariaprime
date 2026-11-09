// Entregadores lidos da CNH: isolamento por condomínio, documento mascarado, revelação auditada só para síndico
// com permissão, dedupe por CPF/CNH, porteiro sem CPF completo, anon sem nada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

let db, A, B, admA, admB, portA, admLim, unitA, loc;
const CPF = '52998224725', CPF2 = '11144477735', CNH = '01234567890';
const uuid = () => crypto.randomUUID();
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message) || assert.fail(e.message));
const provision = async (u, slug, doc) => (await db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: slug, p_slug: slug,
  p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
const upsert = (who, extra = {}, tenant = A) => db.rpc(who, 'courier_upsert_from_ocr', { p_tenant: tenant, p_full_name: 'José da Silva',
  p_cpf: '529.982.247-25', p_cnh: CNH, p_category: 'AB', p_carrier: 'Mercado Livre', ...extra });
const receive = (courier = 'José da Silva') => db.rpc(portA, 'receive_and_store', { p_tenant: A, p_idempotency_key: uuid(), p_unit: unitA,
  p_tracking: null, p_carrier: 'Correios', p_recipient: 'Maria', p_notes: null, p_storage_location: loc, p_label_sha256: null,
  p_courier: courier, p_received_by_name: 'Carlos Porteiro' });
const invite = async (adm, tenant, email, role, perms) => {
  const u = await db.createUser(email);
  const inv = await db.rpc(adm, 'create_invitation', { p_tenant: tenant, p_email: email, p_role: role, p_unit: null, p_permissions: perms });
  await db.rpc(u, 'accept_invitation', { p_token: inv.token });
  return u;
};

before(async () => {
  db = await createDb();
  await db.sql('update plans set published = true');
  admA = await db.createUser('sindico-a@cour.invalid');
  admB = await db.createUser('sindico-b@cour.invalid');
  A = await provision(admA, 'cour-a', '11444777000161');
  B = await provision(admB, 'cour-b', '11222333000181');
  portA = await invite(admA, A, 'porteiro@cour.invalid', 'porteiro', '{}');
  admLim = await invite(admA, A, 'conselho@cour.invalid', 'admin', '{settings}');
  [{ id: unitA }] = await db.as(admA, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [A]);
  const [{ id: conc }] = await db.sql('select id from concierge_locations where tenant_id=$1', [A]);
  [{ id: loc }] = await db.as(admA, "insert into storage_locations(tenant_id,concierge_location_id,code,rack,shelf,capacity) values($1,$2,'A1','E','P1',50) returning id", [A, conc]);
});
after(async () => { await db?.raw.close(); });

test('validação de CPF no banco (dígitos verificadores) e máscaras', async () => {
  const [r] = await db.sql(`select app.cpf_valid('52998224725') a, app.cpf_valid('52998224724') b, app.cpf_valid('11111111111') c,
    app.cpf_valid('5299822472') d, app.mask_cpf('52998224725') m, app.cpf_prefix('52998224725') p`);
  assert.deepEqual([r.a, r.b, r.c, r.d], [true, false, false, false]);
  assert.equal(r.m, '***.982.247-**');
  assert.equal(r.p, '529.***.***-**');
});

test('porteiro cadastra pela CNH revisada; CPF inválido/sem documento recusados; dedupe por CPF ou CNH', async () => {
  await rejects(upsert(portA, { p_cpf: '529.982.247-24' }), /CPF inválido/);
  await rejects(upsert(portA, { p_cpf: null, p_cnh: null }), /CPF ou o número da CNH/);
  await rejects(upsert(portA, { p_cnh: '11111111111' }), /CNH inválido/);
  await rejects(upsert(portA, { p_full_name: 'J' }), /2 a 80/);
  const a = await upsert(portA);
  assert.equal(a.created, true);
  assert.equal(a.document_hint, '529.***.***-**');
  assert.equal(JSON.stringify(a).includes(CPF), false, 'resposta ao porteiro não tem o CPF completo');
  const b = await upsert(portA, { p_full_name: 'José da Silva Jr', p_cnh: null });
  assert.equal(b.id, a.id, 'mesmo CPF = mesmo entregador');
  const c = await upsert(admA, { p_cpf: null, p_category: 'B' });
  assert.equal(c.id, a.id, 'mesma CNH = mesmo entregador');
  assert.equal((await db.sql('select count(*)::int n from couriers where tenant_id=$1', [A]))[0].n, 1);
  // CPF de outro cadastro com a CNH deste: conflito, não mistura.
  await upsert(portA, { p_full_name: 'Outro', p_cpf: CPF2, p_cnh: null });
  await rejects(upsert(portA, { p_cpf: CPF2, p_cnh: CNH }), /entregadores diferentes/);
  // Mesmo CPF em outro condomínio vira outro cadastro (isolado).
  const x = await upsert(admB, {}, B);
  assert.notEqual(x.id, a.id);
  // Auditoria sem documento.
  const logs = await db.sql("select data from audit_logs where action like 'courier.%' and target_id=$1", [a.id]);
  assert.ok(logs.length >= 3);
  assert.ok(logs.every((l) => !JSON.stringify(l.data).includes(CPF) && !JSON.stringify(l.data).includes(CNH)));
});

test('busca: nome sem acento ou 3 primeiros dígitos; nunca devolve o CPF; só a equipe do condomínio', async () => {
  const byName = await db.rpc(portA, 'courier_search', { p_tenant: A, p_query: 'jose silva' });
  assert.ok(byName.some((c) => c.full_name.startsWith('José da Silva')));
  const byDoc = await db.rpc(portA, 'courier_search', { p_tenant: A, p_query: '529' });
  assert.equal(byDoc.length, 1);
  assert.equal(byDoc[0].document_hint, '529.***.***-**');
  // Digitar o CPF inteiro não confirma nada além dos 3 primeiros dígitos.
  const full = await db.rpc(portA, 'courier_search', { p_tenant: A, p_query: '52900000000' });
  assert.deepEqual(full.map((c) => c.id), byDoc.map((c) => c.id));
  assert.ok(!JSON.stringify([byName, byDoc, full]).includes('982'), 'miolo do CPF não aparece na busca');
  await rejects(db.rpc(admB, 'courier_search', { p_tenant: A, p_query: 'jose' }), /Sem permissão/);
  const mor = await db.createUser('morador@cour.invalid');
  await rejects(db.rpc(mor, 'courier_search', { p_tenant: A, p_query: 'jose' }), /Sem permissão/);
});

test('tabela e funções fechadas: anon e authenticated não leem couriers direto', async () => {
  await rejects(db.as(portA, 'select * from couriers'), /permission denied/);
  await rejects(db.as(admA, 'select document_number from couriers'), /permission denied/);
  await rejects(db.as(null, 'select * from couriers'), /permission denied/);
  await rejects(db.as(null, 'truncate couriers'), /permission denied/);
  for (const fn of ['courier_search', 'couriers_list', 'courier_reveal_document', 'courier_upsert_from_ocr']) {
    const [r] = await db.sql(`select has_function_privilege('anon', p.oid, 'execute') a from pg_proc p where proname=$1`, [fn]);
    assert.equal(r.a, false, `${fn} executável por anon`);
  }
  await rejects(db.as(null, "select public.courier_search('00000000-0000-4000-8000-000000000000','jose')"), /permission denied/);
});

test('vínculo encomenda→entregador e painel do síndico com documento mascarado', async () => {
  const [{ id: courier }] = await db.sql("select id from couriers where tenant_id=$1 and document_number=$2", [A, CPF]);
  const pkg = await receive();
  assert.equal(pkg.courier_name, 'José da Silva', 'nome continua gravado');
  const l1 = await db.rpc(portA, 'package_set_courier', { p_tenant: A, p_package: pkg.id, p_courier: courier });
  assert.equal(l1.replayed, false);
  assert.equal((await db.rpc(portA, 'package_set_courier', { p_tenant: A, p_package: pkg.id, p_courier: courier })).replayed, true);
  // Entregador de outro condomínio: recusado (FK composta + checagem).
  const [{ id: other }] = await db.sql('select id from couriers where tenant_id=$1', [B]);
  await rejects(db.rpc(portA, 'package_set_courier', { p_tenant: A, p_package: pkg.id, p_courier: other }), /inválido/);
  await rejects(db.sql('update packages set courier_id=$1 where id=$2', [other, pkg.id]), /foreign key|violates/i);
  await rejects(db.rpc(admB, 'package_set_courier', { p_tenant: A, p_package: pkg.id, p_courier: courier }), /Sem permissão/);

  const list = await db.rpc(admA, 'couriers_list', { p_tenant: A });
  const row = list.find((c) => c.id === courier);
  assert.equal(row.document_masked, '***.982.247-**');
  assert.equal(row.deliveries, 1);
  assert.deepEqual(row.carriers, ['Correios', 'Mercado Livre']);
  assert.ok(!JSON.stringify(list).includes(CPF) && !JSON.stringify(list).includes(CNH));
  await rejects(db.rpc(portA, 'couriers_list', { p_tenant: A }), /administração/);
  await rejects(db.rpc(admB, 'couriers_list', { p_tenant: A }), /administração/);

  const dl = await db.rpc(admA, 'courier_deliveries', { p_tenant: A, p_courier: courier });
  assert.equal(dl.length, 1);
  assert.deepEqual([dl[0].unit_block, dl[0].unit_label, dl[0].carrier, dl[0].received_by_name], ['A', '101', 'Correios', 'Carlos Porteiro']);
  await rejects(db.rpc(portA, 'courier_deliveries', { p_tenant: A, p_courier: courier }), /administração/);
  await rejects(db.rpc(admB, 'courier_deliveries', { p_tenant: B, p_courier: courier }), /não encontrado/);
});

test('revelação: só síndico com approve/team, com justificativa, auditada sem o dado', async () => {
  const [{ id: courier }] = await db.sql("select id from couriers where tenant_id=$1 and document_number=$2", [A, CPF]);
  const reveal = (who, reason = 'Conferência de ocorrência', tenant = A) => db.rpc(who, 'courier_reveal_document', { p_tenant: tenant, p_courier: courier, p_reason: reason });
  await rejects(reveal(portA), /documento completo/);
  await rejects(reveal(admLim), /documento completo/, 'admin sem approve/team');
  await rejects(reveal(admB, 'Conferência de ocorrência', B), /não encontrado/);
  await rejects(reveal(admB), /documento completo/);
  await rejects(reveal(admA, 'curto'), /Justificativa/);
  const before = (await db.sql("select count(*)::int n from audit_logs where action='courier.document_reveal'"))[0].n;
  const r = await reveal(admA);
  assert.equal(r.document_number, '529.982.247-25');
  assert.equal(r.cnh_number, CNH);
  const logs = await db.sql("select actor_id, data from audit_logs where action='courier.document_reveal' order by created_at");
  assert.equal(logs.length, before + 1);
  const last = logs.at(-1);
  assert.equal(last.actor_id, admA);
  assert.equal(last.data.reason, 'Conferência de ocorrência');
  assert.ok(!JSON.stringify(last.data).includes(CPF) && !JSON.stringify(last.data).includes(CNH));
});

test('vínculo: nunca troca, nunca em histórico encerrado, nome precisa conferir com o snapshot', async () => {
  const [{ id: courier }] = await db.sql("select id from couriers where tenant_id=$1 and document_number=$2", [A, CPF]);
  const [{ id: outro }] = await db.sql("select id from couriers where tenant_id=$1 and document_number=$2", [A, CPF2]);
  const link = (who, pkg, c = courier) => db.rpc(who, 'package_set_courier', { p_tenant: A, p_package: pkg, p_courier: c });
  const p1 = await receive();
  await link(portA, p1.id);
  await rejects(link(admA, p1.id, outro), /já vinculada/, 'nem síndico troca o vínculo');
  const p2 = await receive('Nome Divergente');
  await rejects(link(portA, p2.id), /não confere/);
  const p3 = await receive('José da Silva - Mercado Livre');
  assert.equal((await link(portA, p3.id)).replayed, false, 'nome + transportadora da sugestão confere');
  const p4 = await receive();
  await db.sql("update packages set status='RETIRADA', picked_up_at=greatest(now(), received_at), picked_up_by_name='Maria', pickup_method='qr' where id=$1", [p4.id]);
  await rejects(link(admA, p4.id), /Histórico encerrado/);
  const [snap] = await db.sql('select courier_name, courier_id from packages where id=$1', [p4.id]);
  assert.deepEqual([snap.courier_name, snap.courier_id], ['José da Silva', null], 'snapshot intacto');
  const ev = await db.sql("select count(*)::int n from package_events where package_id=$1 and type='courier_linked'", [p4.id]);
  assert.equal(ev[0].n, 0);
});

test('entregas do entregador: paginação por cursor sem repetir nem pular; cursor parcial recusado', async () => {
  const [{ id: courier }] = await db.sql("select id from couriers where tenant_id=$1 and document_number=$2", [A, CPF]);
  for (let i = 0; i < 3; i++) await db.rpc(portA, 'package_set_courier', { p_tenant: A, p_package: (await receive()).id, p_courier: courier });
  const total = (await db.sql('select count(*)::int n from packages where courier_id=$1', [courier]))[0].n;
  const seen = [];
  let cur = {};
  for (;;) {
    const page = await db.rpc(admA, 'courier_deliveries', { p_tenant: A, p_courier: courier, p_limit: 2, ...cur });
    seen.push(...page.map((d) => d.package_id));
    if (page.length < 2) break;
    const last = page.at(-1);
    cur = { p_cursor_at: last.received_at, p_cursor_id: last.package_id };
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  await rejects(db.rpc(admA, 'courier_deliveries', { p_tenant: A, p_courier: courier, p_cursor_at: new Date().toISOString() }), /Cursor inválido/);
  const [ix] = await db.sql("select count(*)::int n from pg_indexes where indexname='packages_tenant_courier_id_idx' and indexdef like '%courier_id%'");
  assert.equal(ix.n, 1, 'índice próprio de courier_id existe');
});

test('foto da CNH: autorização da sessão, anexo só service_role com objeto existente, sem troca; revelação auditada', async () => {
  const [{ id: courier }] = await db.sql("select id from couriers where tenant_id=$1 and document_number=$2", [A, CPF]);
  const path = `${A}/couriers/${courier}/cnh-abcdef1234567890.jpg`;
  const attach = (p, actor = portA) => db.service('select public.courier_attach_photo($1,$2,$3,$4) r', [A, courier, p, actor]).then((r) => r[0].r);
  assert.equal((await db.rpc(portA, 'courier_photo_authorize', { p_tenant: A, p_courier: courier })).actor_id, portA);
  await rejects(db.rpc(admB, 'courier_photo_authorize', { p_tenant: A, p_courier: courier }), /Sem permissão/);
  await rejects(db.rpc(portA, 'courier_attach_photo', { p_tenant: A, p_courier: courier, p_path: path, p_actor: portA }), /permission denied/);
  await rejects(attach(path, admB), /Sem permissão/, 'ator de outro condomínio');
  await rejects(attach(`${B}/couriers/${courier}/cnh-abcdef1234567890.jpg`), /Arquivo inválido/);
  await rejects(attach(`${A}/couriers/${courier}/../x.jpg`), /Arquivo inválido/);
  await rejects(attach(path), /não encontrado/, 'objeto ausente não vira ponteiro');
  await db.service("insert into storage.objects(bucket_id,name,owner) values('tenant-private',$1,null)", [path]);
  assert.equal((await attach(path)).replayed, false);
  assert.equal((await attach(path)).replayed, true, 'retry idempotente');
  const other = `${A}/couriers/${courier}/cnh-zzzzzzzz12345678.jpg`;
  await db.service("insert into storage.objects(bucket_id,name,owner) values('tenant-private',$1,null)", [other]);
  await rejects(attach(other), /substituição não permitida/);
  assert.equal((await db.sql('select cnh_photo_path p from couriers where id=$1', [courier]))[0].p, path, 'ponteiro mantido');
  for (const who of [admA, portA]) {
    assert.equal((await db.as(who, "select count(*)::int n from storage.objects where bucket_id='tenant-private' and name=$1", [path]))[0].n, 0);
  }
  await rejects(db.as(portA, "insert into storage.objects(bucket_id,name,owner) values('tenant-private',$1,$2)", [`${A}/couriers/${courier}/cnh-yyyyyyyy12345678.jpg`, portA]), /row-level security|violates/i);
  const [face] = await db.sql(`select app.can_read_package_file($1) a`, [`${A}/staff-face/x.jpg`]);
  assert.equal(face.a, false, 'prefixo da biometria fechado');
  assert.equal((await db.rpc(admA, 'couriers_list', { p_tenant: A })).find((c) => c.id === courier).has_photo, true);

  const reveal = (who, reason = 'Conferência de ocorrência') => db.rpc(who, 'courier_photo_reveal', { p_tenant: A, p_courier: courier, p_reason: reason });
  await rejects(reveal(portA), /Sem permissão/);
  await rejects(reveal(admLim), /Sem permissão/);
  await rejects(reveal(admA, 'curto'), /Justificativa/);
  assert.equal((await reveal(admA)).path, path);
  const [log] = await db.sql("select actor_id, data from audit_logs where action='courier.photo_reveal' order by created_at desc limit 1");
  assert.equal(log.actor_id, admA);
  assert.ok(!JSON.stringify(log.data).includes(path));
  await db.service("delete from storage.objects where name=$1", [path]);
  await rejects(reveal(admA), /não encontrada no armazenamento/, 'arquivo perdido: sem URL');
});
