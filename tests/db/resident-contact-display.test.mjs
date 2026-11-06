// 20261106000400: nome/e-mail editados pelo síndico (contato do condomínio) valem na listagem, no relatório e no
// reconhecimento da portaria; ativação não contorna solicitação pendente (aprovação + aceite do termo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from './harness.mjs';

const uuid = () => crypto.randomUUID();

async function tenant(db, admin, slug, doc) {
  const t = (await db.rpc(admin, 'provision_tenant', { p_request_id: uuid(), p_name: `Condo ${slug}`, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
  const unit = (await db.sql(`insert into units (tenant_id, block, label) values ($1, 'A', '101') returning id`, [t]))[0].id;
  return { t, unit, slug };
}

async function requestAccess(db, uid, c, name) {
  const term = await db.rpc(null, 'privacy_term_current', { p_slug: c.slug });
  await db.rpc(uid, 'request_access', { p_slug: c.slug, p_full_name: name, p_phone: '+5511988887777', p_block: 'A', p_unit: '101', p_privacy_hash: term.hash });
  return (await db.sql(`select id from access_requests where tenant_id = $1 and user_id = $2 and status = 'pending'`, [c.t, uid]))[0].id;
}

async function approve(db, admin, uid, c, name) {
  const req = await requestAccess(db, uid, c, name);
  await db.rpc(admin, 'decide_access_request', { p_request: req, p_approve: true, p_unit: c.unit, p_reason: null });
}

const members = (db, uid, t) => db.as(uid, 'select * from public.list_members($1)', [t]);
const member = async (db, uid, t, who) => (await members(db, uid, t)).find((x) => x.user_id === who);
const match = (db, uid, t, name) => db.rpc(uid, 'match_recipient', { p_tenant: t, p_name: name, p_block: 'A', p_unit: '101' });
const edit = (db, uid, c, who, name, extra = {}) => db.rpc(uid, 'resident_update',
  { p_tenant: c.t, p_user: who, p_full_name: name, p_phone: null, p_email: null, p_unit: c.unit, ...extra });

async function setup() {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const A = await db.createUser('sindico.a@test.invalid', { name: 'Sindico A' });
  const B = await db.createUser('bob@test.invalid', { name: 'Bob Original' });
  const c1 = await tenant(db, A, 'cnd-a', '11222333000144');
  await approve(db, A, B, c1, 'Bob Original');
  return { db, A, B, c1 };
}

test('edição do síndico vale em list_members, report_residents e match_recipient; nome antigo não casa', async () => {
  const { db, A, B, c1 } = await setup();
  assert.equal((await member(db, A, c1.t, B)).full_name, 'Bob Original');
  assert.equal((await match(db, A, c1.t, 'Bob Original')).status, 'matched');

  await edit(db, A, c1, B, 'Roberto Editado', { p_email: 'Roberto.Edit@Example.com' });
  const m = await member(db, A, c1.t, B);
  assert.equal(m.full_name, 'Roberto Editado');
  assert.equal(m.email, 'roberto.edit@example.com');
  const r = (await db.rpc(A, 'report_residents', { p_tenant: c1.t })).find((x) => x.user_id === B);
  assert.equal(r.full_name, 'Roberto Editado');
  assert.equal(r.email, 'roberto.edit@example.com');
  assert.equal(r.phone, null, 'telefone vem do mesmo contato editado');
  assert.equal((await db.rpc(A, 'report_residents', { p_tenant: c1.t, p_filters: { search: 'Roberto' } })).length, 1);
  assert.equal((await db.rpc(A, 'report_residents', { p_tenant: c1.t, p_filters: { search: 'Bob Original' } })).length, 0);
  assert.equal((await db.rpc(A, 'report_residents', { p_tenant: c1.t, p_filters: { relation: 'locatario' } })).length, 0, 'filtro relation preservado');

  const ok = await match(db, A, c1.t, 'Roberto Editado');
  assert.equal(ok.status, 'matched');
  assert.deepEqual(ok.people.map((p) => p.name), ['Roberto Editado']);
  const old = await match(db, A, c1.t, 'Bob Original');
  assert.equal(old.status, 'unit_only', 'nome antigo do perfil não casa mais');
  assert.equal(old.people.length, 0);

  // Identidade global intocada.
  assert.equal((await db.sql('select full_name from profiles where id = $1', [B]))[0].full_name, 'Bob Original');
  assert.equal((await db.sql('select email from auth.users where id = $1', [B]))[0].email, 'bob@test.invalid');

  // Revogado: contato inativo sai do matcher e a lista volta ao perfil/e-mail de login.
  await edit(db, A, c1, B, 'Roberto Editado', { p_status: 'revoked' });
  const rv = await member(db, A, c1.t, B);
  assert.equal(rv.full_name, 'Bob Original');
  assert.equal(rv.email, 'bob@test.invalid');
  assert.equal(rv.status, 'revoked');
  const gone = await match(db, A, c1.t, 'Roberto Editado');
  assert.equal(gone.status, 'unit_only');
  assert.equal(gone.people.length, 0);
  // Equipe continua com o perfil (contato de morador não vale para outro papel).
  assert.equal((await member(db, A, c1.t, A)).full_name, 'Sindico A');
  await db.raw.close();
});

test('ativação com solicitação pendente é recusada (resident_update e set_membership_status); sem pendência reativa', async () => {
  const { db, A, B, c1 } = await setup();
  const mid = (await member(db, A, c1.t, B)).membership_id;
  await edit(db, A, c1, B, 'Bob Original', { p_status: 'revoked' });

  // Pedido novo, mas sem aceite do termo registrado: decide_access_request recusa e nenhum atalho ativa.
  const req = (await db.sql(`insert into access_requests (tenant_id, user_id, full_name, phone, block_text, unit_text, unit_id, status)
    values ($1, $2, 'Bob Original', '5511988887777', 'A', '101', $3, 'pending') returning id`, [c1.t, B, c1.unit]))[0].id;
  await assert.rejects(db.rpc(A, 'decide_access_request', { p_request: req, p_approve: true, p_unit: c1.unit, p_reason: null }), /aceite do termo/);
  await assert.rejects(edit(db, A, c1, B, 'Bob Original'), /solicitação de cadastro pendente/);
  await assert.rejects(edit(db, A, c1, B, 'Bob Original', { p_status: 'pending' }).then(() => edit(db, A, c1, B, 'Bob Original')), /solicitação de cadastro pendente/);
  await assert.rejects(db.rpc(A, 'set_membership_status', { p_membership: mid, p_status: 'active' }), /solicitação de cadastro pendente/);
  assert.notEqual((await member(db, A, c1.t, B)).status, 'active');

  // Recusada a solicitação, a reativação pelo síndico volta a valer (vínculo já tinha passado por aprovação).
  await db.rpc(A, 'decide_access_request', { p_request: req, p_approve: false, p_unit: null, p_reason: 'Duplicada' });
  await edit(db, A, c1, B, 'Bob Original');
  assert.equal((await member(db, A, c1.t, B)).status, 'active');
  await db.rpc(A, 'set_membership_status', { p_membership: mid, p_status: 'revoked' });
  await db.rpc(A, 'set_membership_status', { p_membership: mid, p_status: 'active' });
  assert.equal((await member(db, A, c1.t, B)).status, 'active');

  // Pedido com aceite (fluxo normal): continua pela aprovação formal.
  await edit(db, A, c1, B, 'Bob Original', { p_status: 'revoked' });
  const req2 = await requestAccess(db, B, c1, 'Bob Original');
  await assert.rejects(edit(db, A, c1, B, 'Bob Original'), /solicitação de cadastro pendente/);
  await db.rpc(A, 'decide_access_request', { p_request: req2, p_approve: true, p_unit: c1.unit, p_reason: null });
  assert.equal((await member(db, A, c1.t, B)).status, 'active');
  await db.raw.close();
});

test('cross-tenant: contato editado em um condomínio não vaza para o outro', async () => {
  const { db, A, B, c1 } = await setup();
  const C = await db.createUser('sindico.c@test.invalid', { name: 'Sindico C' });
  const c2 = await tenant(db, C, 'cnd-c', '11444555000166');
  await approve(db, C, B, c2, 'Bob Original');

  await edit(db, C, c2, B, 'Beto Segundo', { p_email: 'beto@c.example' });
  assert.equal((await member(db, C, c2.t, B)).full_name, 'Beto Segundo');
  assert.equal((await match(db, C, c2.t, 'Beto Segundo')).status, 'matched');

  const m1 = await member(db, A, c1.t, B);
  assert.equal(m1.full_name, 'Bob Original');
  assert.equal(m1.email, 'bob@test.invalid');
  assert.equal((await match(db, A, c1.t, 'Bob Original')).status, 'matched');
  assert.equal((await match(db, A, c1.t, 'Beto Segundo')).status, 'unit_only');
  assert.equal((await db.rpc(A, 'report_residents', { p_tenant: c1.t })).find((x) => x.user_id === B).full_name, 'Bob Original');

  await assert.rejects(members(db, C, c1.t), /permiss/i);
  await assert.rejects(db.rpc(C, 'report_residents', { p_tenant: c1.t }), /aprova moradores/);
  await assert.rejects(match(db, C, c1.t, 'Bob Original'), /permiss/i);
  await assert.rejects(edit(db, C, c1, B, 'Invasor'), /aprova moradores/);
  await assert.rejects(match(db, B, c1.t, 'Bob Original'), /permiss/i, 'morador não usa o matcher');
  await db.raw.close();
});

test('ensaio: 0100, 0300 e 0400 aplicam sobre as definições reais de produção', { skip: !process.env.LOCALAPPDATA && 'sem LOCALAPPDATA' }, async (t) => {
  const defs = join(process.env.LOCALAPPDATA, 'pp-stack', 'prod-1106-defs.sql');
  let sql;
  try { sql = readFileSync(defs, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); } catch { return t.skip(`sem ${defs}`); }
  const db = await createDb({ before: '20261106' });
  await db.raw.exec(sql);
  for (const f of ['20261106000100_units_residents_courier.sql', '20261106000300_resident_management.sql', '20261106000400_resident_contact_display.sql']) {
    await db.applyMigration(f);
  }
  await db.sql('update plans set published = true');
  const A = await db.createUser('sindico.a@test.invalid', { name: 'Sindico A' });
  const B = await db.createUser('bob@test.invalid', { name: 'Bob Original' });
  const c1 = await tenant(db, A, 'cnd-a', '11222333000144');
  await approve(db, A, B, c1, 'Bob Original');
  await edit(db, A, c1, B, 'Roberto Editado');
  assert.equal((await member(db, A, c1.t, B)).full_name, 'Roberto Editado');
  assert.equal((await match(db, A, c1.t, 'Bob Original')).status, 'unit_only');
  await db.raw.close();
});
