// Endereçamento por condomínio (vertical/horizontal) e rastreabilidade do recebimento
// (entregador e porteiro obrigatórios em encomendas novas; antigas continuam válidas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

let db, A, B, admA, admB, portA, unitA, unitCasa, unitLote, loc;
const uuid = () => crypto.randomUUID();
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message) || assert.fail(e.message));
const provision = async (u, slug, doc) => (await db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: slug, p_slug: slug,
  p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
const receive = (extra = {}, who = portA, tenant = A) => db.rpc(who, 'receive_and_store', {
  p_tenant: tenant, p_idempotency_key: uuid(), p_unit: unitA, p_tracking: null, p_carrier: 'Correios', p_recipient: 'Maria Souza',
  p_notes: null, p_storage_location: loc, p_label_sha256: null, p_courier: 'João - Mercado Livre', p_received_by_name: 'Carlos Porteiro', ...extra,
});

before(async () => {
  db = await createDb();
  await db.sql('update plans set published = true');
  admA = await db.createUser('sindico-a@addr.invalid', { name: 'Síndica A' });
  admB = await db.createUser('sindico-b@addr.invalid', { name: 'Síndico B' });
  portA = await db.createUser('porteiro@addr.invalid', { name: 'Carlos Porteiro' });
  A = await provision(admA, 'addr-a', '11444777000161');
  B = await provision(admB, 'addr-b', '11222333000181');
  [{ id: unitA }] = await db.as(admA, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [A]);
  [{ id: unitCasa }] = await db.as(admA, "insert into units(tenant_id,block,label) values($1,'Rua das Palmeiras','12') returning id", [A]);
  [{ id: unitLote }] = await db.as(admA, "insert into units(tenant_id,block,label) values($1,'B','15') returning id", [A]);
  const inv = await db.rpc(admA, 'create_invitation', { p_tenant: A, p_email: 'porteiro@addr.invalid', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
  await db.rpc(portA, 'accept_invitation', { p_token: inv.token });
  const [{ id: conc }] = await db.sql('select id from concierge_locations where tenant_id=$1', [A]);
  [{ id: loc }] = await db.as(admA, "insert into storage_locations(tenant_id,concierge_location_id,code,rack,shelf,capacity) values($1,$2,'A1','Estante A','P1',50) returning id", [A, conc]);
});
after(async () => { await db?.raw.close(); });

test('condomínio novo nasce com Bloco/Apartamento; só quem tem "settings" altera os rótulos, só do próprio condomínio', async () => {
  const [s] = await db.sql('select unit_group_label g, unit_number_label n, condo_type t from tenant_settings where tenant_id=$1', [A]);
  assert.deepEqual([s.g, s.n, s.t], ['Bloco', 'Apartamento', 'vertical']);
  await db.as(admA, "update tenant_settings set unit_group_label='Quadra', unit_number_label='Lote', condo_type='horizontal_lotes' where tenant_id=$1", [A]);
  const [h] = await db.sql('select unit_group_label g, unit_number_label n from tenant_settings where tenant_id=$1', [A]);
  assert.deepEqual([h.g, h.n], ['Quadra', 'Lote']);
  // Síndico de B não altera os rótulos de A (RLS filtra a linha).
  await db.as(admB, "update tenant_settings set unit_group_label='Hack' where tenant_id=$1", [A]);
  assert.equal((await db.sql('select unit_group_label g from tenant_settings where tenant_id=$1', [A]))[0].g, 'Quadra');
  // Porteiro não altera.
  await db.as(portA, "update tenant_settings set unit_group_label='Hack' where tenant_id=$1", [A]).catch(() => {});
  assert.equal((await db.sql('select unit_group_label g from tenant_settings where tenant_id=$1', [A]))[0].g, 'Quadra');
  // Rótulo vazio ou gigante é recusado pelo banco.
  await rejects(db.as(admA, "update tenant_settings set unit_group_label='' where tenant_id=$1", [A]), /check|violates/i);
  await rejects(db.as(admA, "update tenant_settings set condo_type='outro' where tenant_id=$1", [A]), /check|violates/i);
});

test('texto da unidade usa os rótulos do condomínio (avisos e comprovantes); padrão não muda', async () => {
  const d = (tenant, b, l) => db.sql('select app.unit_display($1,$2,$3) t', [tenant, b, l]).then((r) => r[0].t);
  assert.equal(await d(B, 'A', '101'), 'Bloco A · 101', 'condomínio vertical continua igual ao de antes');
  assert.equal(await d(A, 'B', '15'), 'Quadra B · Lote 15');
  assert.equal(await d(A, 'Rua das Palmeiras', '12'), 'Quadra Rua das Palmeiras · Lote 12');
  await db.as(admA, "update tenant_settings set unit_group_label='Rua', unit_number_label='Casa', condo_type='horizontal_casas' where tenant_id=$1", [A]);
  assert.equal(await d(A, 'das Palmeiras', '12'), 'Rua das Palmeiras · Casa 12');
  assert.equal(await d(A, 'Rua das Palmeiras', 'Casa 12'), 'Rua das Palmeiras · Casa 12', 'não repete o prefixo');
  assert.equal(await d(A, null, '12'), 'Casa 12', 'sem agrupador');
  // Contexto do aviso (WhatsApp/e-mail) usa o mesmo texto.
  await db.service("insert into resident_contacts(tenant_id,unit_id,name,email) values($1,$2,'Contato Casa','ctx@addr.invalid')", [A, unitCasa]);
  const pkg = await receive({ p_unit: unitCasa });
  const [{ id: job }] = await db.sql("select id from notification_jobs where tenant_id=$1 and channel='email' and payload->>'package_id'=$2", [A, pkg.id]);
  {
    const ctx = (await db.service('select public.notification_context($1) c', [job]))[0].c;
    assert.match(ctx.package.unit, /^Rua .*Palmeiras · Casa 12$/);
  }
});

test('normalização reconhece prefixos horizontais sem confundir palavras comuns', async () => {
  const [r] = await db.sql(`select app.norm_unit('Lote 15') a, app.norm_unit('LT15') b, app.norm_unit('Casa 12') c, app.norm_unit('Apto 101') d,
    app.norm_unit('Nº 7') e, app.norm_unit('Norte 3') f, app.norm_block('Quadra B') g, app.norm_block('QD B') h, app.norm_block('Bloco A') i,
    app.norm_block('Rua 3') j, app.norm_block('AL 3') k, app.norm_block('Rubi') l, app.norm_block('Alfa') m`);
  assert.deepEqual([r.a, r.b, r.c, r.d, r.e], ['15', '15', '12', '101', '7']);
  assert.equal(r.f, 'NORTE3', 'palavra que começa com N não perde a inicial');
  assert.deepEqual([r.g, r.h, r.i, r.j, r.k], ['B', 'B', 'A', '3', '3']);
  assert.deepEqual([r.l, r.m], ['RUBI', 'ALFA'], 'nome de bloco que começa com AL não é cortado');
});

test('cadastro público e totem recebem os rótulos junto das unidades', async () => {
  const p = await db.as(null, "select public.portal_units('addr-a') r").then((r) => r[0].r);
  assert.equal(p.group_label, 'Rua');
  assert.equal(p.number_label, 'Casa');
  assert.ok(Array.isArray(p.units) && p.units.length >= 3);
  const pb = await db.as(null, "select public.portal_units('addr-b') r").then((r) => r[0].r);
  assert.deepEqual([pb.group_label, pb.number_label], ['Bloco', 'Apartamento'], 'outro condomínio mantém o padrão');
});

test('recebimento exige entregador e porteiro; antigos continuam legíveis', async () => {
  const before = (await db.sql('select count(*)::int n from packages where tenant_id=$1', [A]))[0].n;
  await rejects(receive({ p_courier: null }), /nome do entregador/i);
  await rejects(receive({ p_courier: '   ' }), /nome do entregador/i);
  await rejects(receive({ p_courier: 'X' }), /nome do entregador/i);
  await rejects(receive({ p_courier: 'a'.repeat(81) }), /muito longo/i);
  await rejects(receive({ p_received_by_name: 'a'.repeat(121) }), /muito longo/i);
  // Nada foi gravado pelas tentativas recusadas.
  assert.equal((await db.sql('select count(*)::int n from packages where tenant_id=$1', [A]))[0].n, before);

  const ok = await receive();
  assert.equal(ok.courier_name, 'João - Mercado Livre');
  assert.equal(ok.received_by_name, 'Carlos Porteiro');
  // Porteiro em branco: assume o operador logado (nome do perfil).
  const auto = await receive({ p_received_by_name: '' });
  assert.equal(auto.received_by_name, 'Carlos Porteiro');
  // Porteiro de terminal compartilhado: o nome digitado vale.
  const shared = await receive({ p_received_by_name: 'Turno Noite - Ana' });
  assert.equal(shared.received_by_name, 'Turno Noite - Ana');
  // Retry com a mesma chave devolve o registro, sem duplicar.
  const key = uuid();
  const a = await receive({ p_idempotency_key: key });
  const b = await receive({ p_idempotency_key: key });
  assert.equal(a.id, b.id);
  assert.equal(b.replayed, true);

  // Registro antigo (sem os campos) continua existindo e legível; as colunas aceitam NULL.
  await db.service("insert into packages(tenant_id,unit_id,status,carrier,idempotency_key,received_at) values($1,$2,'RECEBIDA','Correios','legacy-key-01',now())", [A, unitA]);
  const legacy = await db.as(portA, "select courier_name, received_by_name from public.list_packages($1,'PENDENTES',null,null,'legacy',50,null,null)", [A]).catch(() => []);
  assert.ok(Array.isArray(legacy));
  const [row] = await db.sql("select courier_name, received_by_name from packages where idempotency_key='legacy-key-01'");
  assert.deepEqual([row.courier_name, row.received_by_name], [null, null]);
});

test('slug da demonstração é reservado: nenhum condomínio real o usa', async () => {
  const [r] = await db.sql("select app.reserved_slug('demonstracao') a, app.reserved_slug('Demo') b, app.reserved_slug('addr-a') c");
  assert.deepEqual([r.a, r.b, r.c], [true, true, false]);
  const u = await db.createUser('slug@addr.invalid');
  await rejects(provision(u, 'demonstracao', '04252011000110'), /reserv|slug|check|violates|disponível|inválid/i);
});

test('só equipe registra; porteiro de outro condomínio não grava com nomes válidos', async () => {
  const mor = await db.createUser('morador@addr.invalid', { name: 'Moradora' });
  await rejects(receive({}, mor), /Sem permissão/);
  await rejects(receive({}, portA, B), /Sem permissão/);
});

test('lista da portaria, relatório do síndico e app do morador mostram entregador e porteiro', async () => {
  const pkg = await receive({ p_tracking: 'TRK-LIST-1', p_courier: 'Zé - Loggi', p_received_by_name: 'Plantão Dia' });
  const [l] = await db.as(portA, 'select * from public.list_packages($1,null,null,null,$2,5,null,null)', [A, 'TRK-LIST-1']);
  assert.deepEqual([l.courier_name, l.received_by_name], ['Zé - Loggi', 'Plantão Dia']);
  const rep = await db.rpc(admA, 'report_packages', { p_tenant: A, p_filters: { search: 'TRK-LIST-1' }, p_limit: 5 });
  assert.deepEqual([rep[0].courier_name, rep[0].received_by_name], ['Zé - Loggi', 'Plantão Dia']);
  const [rj] = await db.sql('select app.resident_package_json(p) j from packages p where p.id=$1', [pkg.id]);
  assert.deepEqual([rj.j.courier_name, rj.j.received_by_name], ['Zé - Loggi', 'Plantão Dia']);
  // Relatório continua restrito à administração.
  await rejects(db.rpc(portA, 'report_packages', { p_tenant: A, p_filters: {}, p_limit: 5 }), /administração/i);
  await rejects(db.rpc(admB, 'report_packages', { p_tenant: A, p_filters: {}, p_limit: 5 }), /administração/i);
});

test('comprovante guarda entregador, porteiro do recebimento e unidade formatada no snapshot imutável', async () => {
  const pkg = await receive({ p_unit: unitCasa, p_courier: 'Marcos - Amazon', p_received_by_name: 'Carlos Porteiro', p_tracking: 'TRK-SNAP-1' });
  const [{ id: person }] = await db.sql("select id from auth.users where email='porteiro@addr.invalid'");
  const sig = `${A}/packages/${pkg.id}/signature-abcdef12.png`;
  const photo = `${A}/packages/${pkg.id}/handover-abcdef12.jpg`;
  for (const p of [sig, photo]) await db.service("insert into storage.objects(bucket_id,name,owner) values('tenant-private',$1,$2)", [p, person]);
  const out = await db.rpc(portA, 'deliver_package', { p_tenant: A, p_package: pkg.id, p_request: uuid(), p_qr: null,
    p_picked_up_by: 'Maria Souza', p_recipient_kind: 'morador', p_signature_path: sig, p_item_photo_path: photo, p_manual_reason: 'Morador sem celular para mostrar o QR' });
  const [r] = await db.sql('select snapshot from receipts where package_id=$1', [pkg.id]);
  assert.equal(r.snapshot.courier_name, 'Marcos - Amazon');
  assert.equal(r.snapshot.received_by_name, 'Carlos Porteiro');
  assert.match(r.snapshot.unit_text, /Casa 12/);
  assert.ok(out.protocol);
  // O snapshot não muda depois: trocar o rótulo do condomínio não reescreve o comprovante.
  await db.as(admA, "update tenant_settings set unit_group_label='Alameda' where tenant_id=$1", [A]);
  const [again] = await db.sql('select snapshot from receipts where package_id=$1', [pkg.id]);
  assert.equal(again.snapshot.unit_text, r.snapshot.unit_text);
  await rejects(db.service("update receipts set snapshot='{}' where package_id=$1", [pkg.id]), /imutável|append-only|bloqueado|permission/i);
});
