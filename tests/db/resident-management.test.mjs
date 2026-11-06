// Gestão de moradores pelo síndico (migration 20261106000300): editar/excluir com isolamento entre condomínios,
// vínculo novo na troca de unidade (sem comprovante retroativo), limite por unidade e exclusão que preserva histórico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const uuid = () => crypto.randomUUID();

async function setup() {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const sind = await db.createUser('s@ga.invalid', { name: 'Síndica GA' });
  const sindB = await db.createUser('s@gb.invalid', { name: 'Síndico GB' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: `Cond ${slug}`, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sind, 'gest-a', '11444777000161');
  const B = await prov(sindB, 'gest-b', '04252011000110');
  const unit = async (T, block, label) => (await db.sql('insert into units (tenant_id, block, label) values ($1,$2,$3) returning id', [T, block, label]))[0].id;
  const [a101, a102, a201] = [await unit(A, 'A', '101'), await unit(A, 'A', '102'), await unit(A, 'B', '201')];
  const b101 = await unit(B, 'A', '101');
  // Morador via convite (fluxo real: vínculo + contato criados pelo aceite).
  const invite = async (adm, T, email, u, name) => {
    const uid = await db.createUser(email, { name });
    const inv = await db.rpc(adm, 'create_invitation', { p_tenant: T, p_email: email, p_role: 'morador', p_unit: u, p_permissions: '{}' });
    await db.rpc(uid, 'accept_invitation', { p_token: inv.token });
    return uid;
  };
  return { db, sind, sindB, A, B, a101, a102, a201, b101, invite };
}

test('autorização e matriz entre condomínios', async () => {
  const s = await setup();
  const { db, sind, sindB, A, B, a101, b101 } = s;
  try {
    const ana = await s.invite(sind, A, 'ana@ga.invalid', a101, 'Ana Lima');
    // Admin sem "approve" e porteiro.
    const semAprov = await db.createUser('adm@ga.invalid', { name: 'Admin Sem' });
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'admin','{settings}','active')", [A, semAprov]);
    const port = await db.createUser('port@ga.invalid', { name: 'Porteiro GA' });
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'porteiro','{}','active')", [A, port]);
    const upd = { p_tenant: A, p_user: ana, p_full_name: 'Ana X', p_phone: '11988887777', p_email: null, p_unit: a101 };
    for (const who of [semAprov, port, ana, sindB]) {
      await assert.rejects(db.rpc(who, 'resident_admin_get', { p_tenant: A, p_user: ana }), /Somente quem aprova/);
      await assert.rejects(db.rpc(who, 'resident_update', upd), /Somente quem aprova/);
      await assert.rejects(db.rpc(who, 'resident_delete', { p_tenant: A, p_user: ana }), /Somente quem aprova/);
    }
    // Síndico B no próprio condomínio, mas com morador / unidade de A.
    await assert.rejects(db.rpc(sindB, 'resident_admin_get', { p_tenant: B, p_user: ana }), /não encontrado/);
    await assert.rejects(db.rpc(sindB, 'resident_update', { ...upd, p_tenant: B, p_unit: b101 }), /não encontrado/);
    await assert.rejects(db.rpc(sindB, 'resident_delete', { p_tenant: B, p_user: ana }), /não encontrado/);
    // Síndico A não move morador de A para unidade de B.
    await assert.rejects(db.rpc(sind, 'resident_update', { ...upd, p_unit: b101 }), /Unidade inválida/);
    // Equipe não é gerida por este caminho; nem a si mesmo.
    await assert.rejects(db.rpc(sind, 'resident_delete', { p_tenant: A, p_user: port }), /não encontrado/);
    await assert.rejects(db.rpc(sind, 'resident_delete', { p_tenant: A, p_user: sind }), /próprio cadastro/);
    // Anon e helpers.
    const [g] = await db.sql(`select has_function_privilege('anon', 'public.resident_delete(uuid,uuid)', 'execute') a,
      has_function_privilege('anon', 'public.resident_update(uuid,uuid,text,text,text,uuid,uuid,text)', 'execute') b,
      has_function_privilege('anon', 'public.access_request_cancel(uuid,text)', 'execute') c,
      has_function_privilege('authenticated', 'app.contact_phone(text)', 'execute') h`);
    assert.deepEqual([g.a, g.b, g.c, g.h], [false, false, false, false]);
    // Solicitações e convites de A: síndico B não toca.
    const term = await db.rpc(null, 'privacy_term_current', { p_slug: 'gest-a' });
    const bia = await db.createUser('bia@ga.invalid', { name: 'Bia Souza' });
    const r = await db.rpc(bia, 'request_access', { p_slug: 'gest-a', p_full_name: 'Bia Souza', p_phone: '11977776666', p_block: 'A', p_unit: '101', p_privacy_hash: term.hash });
    await assert.rejects(db.rpc(sindB, 'access_request_admin_update', { p_request: r.request_id, p_full_name: 'X Y', p_phone: null, p_block: 'A', p_unit_text: '1', p_unit: null }), /Somente quem aprova/);
    await assert.rejects(db.rpc(sindB, 'access_request_cancel', { p_request: r.request_id }), /Somente quem aprova/);
    await assert.rejects(db.rpc(sind, 'access_request_admin_update', { p_request: r.request_id, p_full_name: 'Bia Souza', p_phone: null, p_block: 'A', p_unit_text: '101', p_unit: b101 }), /Unidade inválida/);
    const inv = await db.rpc(sind, 'create_invitation', { p_tenant: A, p_email: 'novo@ga.invalid', p_role: 'morador', p_unit: a101, p_permissions: '{}' });
    await assert.rejects(db.rpc(sindB, 'invitation_update', { p_invitation: inv.invitation_id, p_unit: b101 }), /Somente quem aprova/);
    await assert.rejects(db.rpc(sind, 'invitation_update', { p_invitation: inv.invitation_id, p_unit: b101 }), /Unidade inválida/);
    await assert.rejects(db.rpc(sind, 'invitation_update', { p_invitation: inv.invitation_id, p_unit: null }), /Unidade inválida/);
  } finally { await db.raw.close(); }
});

test('edição: identidade global intocada, NULLs, origem inventada, troca de unidade sem comprovante retroativo e limite', async () => {
  const s = await setup();
  const { db, sind, A, B, a101, a102, a201, b101 } = s;
  try {
    const ana = await s.invite(sind, A, 'ana@ga.invalid', a101, 'Ana Lima');
    const before = await db.sql('select u.email, p.full_name, p.phone from auth.users u join profiles p on p.id = u.id where u.id = $1', [ana]);
    const base = { p_tenant: A, p_user: ana, p_full_name: 'Ana Lima Souza', p_phone: '+1 202 555 0123', p_email: 'Contato@Ana.invalid', p_unit: a101 };

    // NULL e situação inválida não passam.
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_status: null }), /Situação inválida/);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_status: 'approved' }), /Situação inválida/);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_full_name: null }), /Informe o nome/);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_phone: '12345' }), /Celular inválido/);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_email: 'sem-arroba' }), /E-mail de contato/);

    const r = await db.rpc(sind, 'resident_update', base);
    assert.equal(r.full_name, 'Ana Lima Souza');
    assert.equal(r.contact_phone, '+12025550123', 'DDI internacional');
    assert.equal(r.contact_email, 'contato@ana.invalid');
    assert.equal(r.login_email, 'ana@ga.invalid');
    assert.deepEqual(await db.sql('select u.email, p.full_name, p.phone from auth.users u join profiles p on p.id = u.id where u.id = $1', [ana]), before,
      'e-mail de login e perfil global não mudam');
    assert.equal((await db.rpc(sind, 'resident_update', { ...base, p_phone: '(11) 98888-7777' })).contact_phone, '+5511988887777');

    // Origem inventada: unidade de outro condomínio ou sem vínculo é recusada e não duplica.
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_unit: a102, p_from_unit: b101 }), /origem não encontrado/);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_unit: a102, p_from_unit: a201 }), /origem não encontrado/);
    assert.equal((await db.sql('select count(*)::int n from unit_memberships where user_id = $1', [ana]))[0].n, 1);

    // Recibo emitido na unidade de destino ANTES da mudança.
    const [{ id: pkg }] = await db.sql(`insert into packages (tenant_id, unit_id, status, idempotency_key, received_at, picked_up_at, picked_up_by_name, pickup_method)
      values ($1,$2,'RETIRADA','gest-key-0001', now() - interval '2 days', now() - interval '1 day', 'Morador Antigo', 'qr') returning id`, [A, a102]);
    await db.sql(`insert into receipts (tenant_id, package_id, protocol, issued_at, snapshot) values ($1,$2,'GEST-0001', now() - interval '1 day', '{}')`, [A, pkg]);
    const oldLink = (await db.sql('select id, created_at from unit_memberships where user_id = $1', [ana]))[0];
    const moved = await db.rpc(sind, 'resident_update', { ...base, p_unit: a102 });
    assert.deepEqual(moved.units.map((u) => [u.unit_id, u.status]), [[a102, 'active']], 'sem duplicar vínculo');
    const newLink = (await db.sql('select id, created_at from unit_memberships where user_id = $1', [ana]))[0];
    assert.notEqual(newLink.id, oldLink.id, 'vínculo novo');
    assert.ok(newLink.created_at > oldLink.created_at, 'created_at reiniciado');
    const pkgView = await db.rpc(ana, 'resident_package', { p_tenant: A, p_package: pkg });
    assert.equal(pkgView.receipt, null, 'comprovante anterior à mudança não fica visível');
    assert.equal((await db.sql('select count(*)::int n from resident_contacts where user_id = $1 and unit_id = $2', [ana, a101]))[0].n, 0, 'contato saiu da origem');
    assert.equal((await db.sql('select count(*)::int n from resident_contacts where user_id = $1 and unit_id = $2 and active', [ana, a102]))[0].n, 1);

    // Revogar e limite na reativação.
    const rev = await db.rpc(sind, 'resident_update', { ...base, p_unit: a102, p_status: 'revoked' });
    assert.equal(rev.status, 'revoked');
    assert.equal(rev.units[0].status, 'revoked');
    assert.equal((await db.sql('select count(*)::int n from resident_contacts where user_id = $1 and active', [ana]))[0].n, 0);
    await db.sql('update tenant_settings set max_residents_per_unit = 1 where tenant_id = $1', [A]);
    await s.invite(sind, A, 'caio@ga.invalid', a102, 'Caio Melo');
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_unit: a102, p_status: 'active' }), /limite de 1/);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_unit: a102, p_status: 'pending' }).then(() =>
      db.rpc(sind, 'resident_update', { ...base, p_unit: a102, p_status: 'active' })), /limite de 1/);
    // Mudar para outra unidade livre reativa com vínculo novo.
    const ok = await db.rpc(sind, 'resident_update', { ...base, p_unit: a201, p_status: 'active' });
    assert.deepEqual([ok.status, ok.units.length, ok.units[0].unit_id, ok.units[0].status], ['active', 1, a201, 'active']);
    // Unidade desativada não aceita vínculo.
    await db.sql('update units set active = false where id = $1', [a101]);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_unit: a101 }), /Unidade inválida/);

    // Morador com duas unidades: origem obrigatória.
    await db.sql("insert into unit_memberships (tenant_id, unit_id, user_id) values ($1,$2,$3)", [A, a102, ana]);
    await assert.rejects(db.rpc(sind, 'resident_update', { ...base, p_unit: a201 }), /mais de uma unidade/);
    void B;
  } finally { await db.raw.close(); }
});

test('exclusão: preserva encomendas, comprovantes, auditoria e aceites; cancela só neste condomínio', async () => {
  const s = await setup();
  const { db, sind, sindB, A, B, a101, b101 } = s;
  try {
    // Mesma conta em A e B.
    const ana = await s.invite(sind, A, 'ana@ga.invalid', a101, 'Ana Lima');
    const inB = await db.rpc(sindB, 'create_invitation', { p_tenant: B, p_email: 'ana@ga.invalid', p_role: 'morador', p_unit: b101, p_permissions: '{}' });
    await db.rpc(ana, 'accept_invitation', { p_token: inB.token });
    // Pedido pendente com aceite (em A), convite pendente para outra unidade (A e B), rascunhos (A).
    await db.sql("update tenant_memberships set status = 'revoked' where tenant_id = $1 and user_id = $2", [A, ana]);
    const term = await db.rpc(null, 'privacy_term_current', { p_slug: 'gest-a' });
    const req = await db.rpc(ana, 'request_access', { p_slug: 'gest-a', p_full_name: 'Ana Lima', p_phone: '11988887777', p_block: 'A', p_unit: '101', p_privacy_hash: term.hash });
    const invA = await db.rpc(sind, 'create_invitation', { p_tenant: A, p_email: 'ana@ga.invalid', p_role: 'morador', p_unit: s.a102, p_permissions: '{}' });
    const invB = await db.rpc(sindB, 'create_invitation', { p_tenant: B, p_email: 'ana@ga.invalid', p_role: 'morador', p_unit: b101, p_permissions: '{}' });
    await db.sql(`insert into resident_signup_drafts (user_id, tenant_id, full_name, phone, unit_text, privacy_hash) values ($1,$2,'Ana Lima','+5511988887777','101','x')`, [ana, A]);
    await db.sql(`insert into notifications (tenant_id, user_id, kind, title, body) values ($1,$3,'k','t','b'),($2,$3,'k','t','b')`, [A, B, ana]);
    // Jobs já enfileirados (o guard de destinatário roda no insert; aqui simulamos fila pré-existente).
    await db.raw.exec(`set session_replication_role = replica;
      insert into notification_jobs (tenant_id, event, channel, recipient, ref_id) values ('${A}','package_received','email','ana@ga.invalid','x1'),('${B}','package_received','email','ana@ga.invalid','x2');
      set session_replication_role = origin;`);
    // Encomenda + comprovante na unidade de A.
    const [{ id: pkg }] = await db.sql(`insert into packages (tenant_id, unit_id, status, idempotency_key, picked_up_at, picked_up_by_name, pickup_method)
      values ($1,$2,'RETIRADA','gest-key-0002', now(), 'Ana Lima', 'qr') returning id`, [A, a101]);
    await db.sql(`insert into receipts (tenant_id, package_id, protocol, snapshot) values ($1,$2,'GEST-0002','{}')`, [A, pkg]);
    const count = async () => (await db.sql(`select (select count(*) from packages)::int p, (select count(*) from receipts)::int r,
      (select count(*) from privacy_acknowledgements where user_id = $1)::int a, (select count(*) from audit_logs)::int l`, [ana]))[0];
    const before = await count();
    assert.equal(before.a, 1);

    const del = await db.rpc(sind, 'resident_delete', { p_tenant: A, p_user: ana });
    assert.deepEqual([del.deleted, del.cancelled_requests, del.revoked_invitations], [true, 1, 1]);
    const after = await count();
    assert.deepEqual([after.p, after.r, after.a], [before.p, before.r, before.a], 'encomendas, comprovantes e aceites preservados');
    assert.ok(after.l > before.l, 'auditoria cresce, nunca diminui');
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action = 'resident.deleted' and tenant_id = $1", [A]))[0].n, 1);

    // A: nada sobra do cadastro.
    const q = async (sql) => (await db.sql(sql, [A, ana]))[0].n;
    assert.equal(await q('select count(*)::int n from tenant_memberships where tenant_id = $1 and user_id = $2'), 0);
    assert.equal(await q('select count(*)::int n from unit_memberships where tenant_id = $1 and user_id = $2'), 0);
    assert.equal(await q('select count(*)::int n from resident_contacts where tenant_id = $1 and user_id = $2'), 0);
    assert.equal(await q('select count(*)::int n from notifications where tenant_id = $1 and user_id = $2'), 0);
    assert.equal(await q('select count(*)::int n from resident_signup_drafts where tenant_id = $1 and user_id = $2'), 0);
    assert.equal((await db.sql('select status from access_requests where id = $1', [req.request_id]))[0].status, 'cancelled');
    assert.ok((await db.sql('select revoked_at from invitations where id = $1', [invA.invitation_id]))[0].revoked_at);
    assert.equal((await db.sql("select status from notification_jobs where ref_id = 'x1'"))[0].status, 'disabled');
    // B e identidade global intactos.
    assert.equal((await db.sql("select status from tenant_memberships where tenant_id = $1 and user_id = $2", [B, ana]))[0].status, 'active');
    assert.equal((await db.sql('select count(*)::int n from unit_memberships where tenant_id = $1 and user_id = $2', [B, ana]))[0].n, 1);
    assert.equal((await db.sql('select count(*)::int n from notifications where tenant_id = $1 and user_id = $2', [B, ana]))[0].n, 1);
    assert.equal((await db.sql('select revoked_at from invitations where id = $1', [invB.invitation_id]))[0].revoked_at, null);
    assert.equal((await db.sql("select status from notification_jobs where ref_id = 'x2'"))[0].status, 'queued');
    assert.equal((await db.sql('select count(*)::int n from auth.users where id = $1', [ana]))[0].n, 1);
    assert.equal((await db.sql('select full_name from profiles where id = $1', [ana]))[0].full_name, 'Ana Lima');
    // Repetir: não encontrado (idempotência explícita).
    await assert.rejects(db.rpc(sind, 'resident_delete', { p_tenant: A, p_user: ana }), /não encontrado/);
    // Pode pedir de novo pelo portal (nova decisão do síndico, nada automático).
    const again = await db.rpc(ana, 'request_access', { p_slug: 'gest-a', p_full_name: 'Ana Lima', p_phone: '11988887777', p_block: 'A', p_unit: '101', p_privacy_hash: term.hash });
    assert.equal(again.status, 'pending');
  } finally { await db.raw.close(); }
});

test('solicitação pendente e convite: editar e cancelar sem pular aceite', async () => {
  const s = await setup();
  const { db, sind, A, a101, a102 } = s;
  try {
    const term = await db.rpc(null, 'privacy_term_current', { p_slug: 'gest-a' });
    const bia = await db.createUser('bia@ga.invalid', { name: 'Bia Souza' });
    const r = await db.rpc(bia, 'request_access', { p_slug: 'gest-a', p_full_name: 'Bia Souza', p_phone: '11977776666', p_block: 'Z', p_unit: '999', p_privacy_hash: term.hash });
    const args = { p_request: r.request_id, p_full_name: 'Bia Souza Lima', p_phone: '+351 912 345 678', p_block: 'A', p_unit_text: '102', p_unit: a102 };
    await assert.rejects(db.rpc(sind, 'access_request_admin_update', { ...args, p_unit_text: null }), /unidade obrigatória/);
    await db.rpc(sind, 'access_request_admin_update', args);
    const [row] = await db.sql('select full_name, phone, block_text, unit_text, unit_id, status from access_requests where id = $1', [r.request_id]);
    assert.deepEqual(row, { full_name: 'Bia Souza Lima', phone: '+351912345678', block_text: 'A', unit_text: '102', unit_id: a102, status: 'pending' });
    // Aceite segue exigido na aprovação: sem aceite, editar não libera.
    const cai = await db.createUser('cai@ga.invalid', { name: 'Caio Melo' });
    await db.sql(`insert into access_requests (tenant_id, user_id, full_name, unit_text) values ($1,$2,'Caio Melo','101')`, [A, cai]);
    const [{ id: semAceite }] = await db.sql('select id from access_requests where user_id = $1', [cai]);
    await db.rpc(sind, 'access_request_admin_update', { ...args, p_request: semAceite, p_full_name: 'Caio Melo', p_phone: null, p_unit: a101 });
    await assert.rejects(db.rpc(sind, 'decide_access_request', { p_request: semAceite, p_approve: true, p_unit: a101, p_reason: null }), /aceite do termo/);
    // Cancelar: só pendente; rascunho do condomínio sai; aceites ficam.
    await db.sql(`insert into resident_signup_drafts (user_id, tenant_id, full_name, phone, unit_text, privacy_hash) values ($1,$2,'Bia','+5511977776666','1','x')`, [bia, A]);
    const c = await db.rpc(sind, 'access_request_cancel', { p_request: r.request_id, p_reason: null });
    assert.equal(c.status, 'cancelled');
    assert.equal((await db.sql('select count(*)::int n from resident_signup_drafts where user_id = $1', [bia]))[0].n, 0);
    assert.equal((await db.sql('select count(*)::int n from privacy_acknowledgements where access_request_id = $1', [r.request_id]))[0].n, 1);
    await assert.rejects(db.rpc(sind, 'access_request_cancel', { p_request: r.request_id }), /Só solicitações pendentes/);
    await assert.rejects(db.rpc(sind, 'access_request_admin_update', args), /Só solicitações pendentes/);
    // Convite: trocar unidade; usado não pode.
    const inv = await db.rpc(sind, 'create_invitation', { p_tenant: A, p_email: 'dani@ga.invalid', p_role: 'morador', p_unit: a101, p_permissions: '{}' });
    await db.rpc(sind, 'invitation_update', { p_invitation: inv.invitation_id, p_unit: a102 });
    const dani = await db.createUser('dani@ga.invalid', { name: 'Dani Reis' });
    await db.rpc(dani, 'accept_invitation', { p_token: inv.token });
    assert.equal((await db.sql('select unit_id from unit_memberships where user_id = $1', [dani]))[0].unit_id, a102);
    await assert.rejects(db.rpc(sind, 'invitation_update', { p_invitation: inv.invitation_id, p_unit: a101 }), /já usado/);
  } finally { await db.raw.close(); }
});
