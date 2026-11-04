// Perfil do morador (migration 20261104000300): cadastro → pedido → vínculo, fila e relatório.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('perfil do morador: do rascunho/pedido ao vínculo, só o próprio pedido, visível ao síndico', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const sind = await db.createUser('s@a.invalid', { name: 'Síndica A' });
    const { tenant_id: A } = await db.rpc(sind, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond A', p_slug: 'perf-a', p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
    await db.sql("insert into units (tenant_id, block, label) values ($1,'A','101')", [A]);
    const term = await db.rpc(null, 'privacy_term_current', { p_slug: 'perf-a' });

    // Logado: envia o pedido e informa o perfil.
    const ana = await db.createUser('ana@a.invalid', { name: 'Ana Lima' });
    const r = await db.rpc(ana, 'request_access', { p_slug: 'perf-a', p_full_name: 'Ana Lima', p_phone: '11988887777', p_block: 'A', p_unit: '101', p_privacy_hash: term.hash });
    await assert.rejects(db.rpc(ana, 'access_request_set_relation', { p_slug: 'perf-a', p_relation: 'dono' }), /Escolha o perfil/);
    await db.rpc(ana, 'access_request_set_relation', { p_slug: 'perf-a', p_relation: 'locatario' });
    // Outra pessoa não altera o pedido de Ana (só o próprio pendente).
    const intruso = await db.createUser('x@a.invalid', { name: 'Intruso Teste' });
    await assert.rejects(db.rpc(intruso, 'access_request_set_relation', { p_slug: 'perf-a', p_relation: 'proprietario' }), /Nenhuma solicitação/);
    assert.equal((await db.sql('select relation from access_requests where id=$1', [r.request_id]))[0].relation, 'locatario');
    const fila = await db.rpc(sind, 'list_access_requests', { p_tenant: A, p_status: 'pending' });
    assert.equal(fila[0].relation, 'locatario', 'síndico vê o perfil na fila');
    await db.rpc(sind, 'decide_access_request', { p_request: r.request_id, p_approve: true, p_unit: null, p_reason: null });
    assert.equal((await db.sql('select relation from unit_memberships where user_id=$1', [ana]))[0].relation, 'locatario', 'perfil vai para o vínculo');

    // Cadastro com rascunho (confirmação de e-mail): o perfil vem do signUp e chega ao pedido.
    const [{ id: bia }] = await db.sql(`insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ('bia@a.invalid', now(), $1) returning id`,
      [JSON.stringify({ full_name: 'Bia Souza', pp_signup: { slug: 'perf-a', full_name: 'Bia Souza', phone: '21987654321', block: 'A', unit: '101', relation: 'dependente', privacy_hash: term.hash } })]);
    assert.equal((await db.sql('select relation from resident_signup_drafts where user_id=$1', [bia]))[0].relation, 'dependente');
    const fin = await db.rpc(bia, 'resident_signup_finalize', {});
    assert.equal(fin.status, 'created');
    assert.equal((await db.sql('select relation from access_requests where id=$1', [fin.request_id]))[0].relation, 'dependente');
    // Perfil inválido no metadata não impede a conta (fica sem perfil).
    const [{ id: cai }] = await db.sql(`insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ('cai@a.invalid', now(), $1) returning id`,
      [JSON.stringify({ full_name: 'Caio Melo', pp_signup: { slug: 'perf-a', full_name: 'Caio Melo', phone: '31991234567', block: 'A', unit: '101', relation: 'hacker', privacy_hash: term.hash } })]);
    assert.equal((await db.sql('select relation from resident_signup_drafts where user_id=$1', [cai]))[0].relation, null);

    // Relatório: perfil e filtro por perfil.
    const rep = await db.rpc(sind, 'report_residents', { p_tenant: A, p_filters: { relation: 'locatario' } });
    assert.deepEqual(rep.map((x) => [x.full_name, x.relation]), [['Ana Lima', 'locatario']]);
    assert.equal((await db.rpc(sind, 'report_residents', { p_tenant: A, p_filters: { relation: 'dependente' } }))[0].status, 'pending');
    // Inventário.
    const [f] = await db.sql(`select has_function_privilege('anon', 'public.access_request_set_relation(text,text)', 'execute') a,
      has_function_privilege('authenticated', 'app.access_request_relation_to_membership()', 'execute') h`);
    assert.deepEqual([f.a, f.h], [false, false]);
  } finally { await db.raw.close(); }
});

test('link de nova senha do morador: só quem aprova, só morador deste condomínio, com intervalo', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const sind = await db.createUser('s@r.invalid', { name: 'Síndica R' });
    const sindB = await db.createUser('s@rb.invalid', { name: 'Síndico RB' });
    const { tenant_id: A } = await db.rpc(sind, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond R', p_slug: 'reset-a', p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
    const { tenant_id: B } = await db.rpc(sindB, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond RB', p_slug: 'reset-b', p_document: '04252011000110', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
    const mor = await db.createUser('Maria@R.invalid', { name: 'Maria R' });
    const both = await db.createUser('dupla@r.invalid', { name: 'Dupla R' });
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'morador','{}','active'),($1,$3,'morador','{}','active'),($4,$3,'morador','{}','active')", [A, mor, both, B]);
    const r = await db.rpc(sind, 'resident_password_reset_check', { p_tenant: A, p_user: mor });
    assert.equal(r.email, 'maria@r.invalid'); assert.equal(r.email_masked, 'm***@r.invalid');
    await assert.rejects(db.rpc(sind, 'resident_password_reset_check', { p_tenant: A, p_user: mor }), /Aguarde 10 minutos/, 'intervalo entre envios');
    await assert.rejects(db.rpc(sindB, 'resident_password_reset_check', { p_tenant: A, p_user: mor }), /Somente quem aprova/, 'síndico de outro condomínio');
    await assert.rejects(db.rpc(sindB, 'resident_password_reset_check', { p_tenant: B, p_user: mor }), /não encontrado/, 'morador de outro condomínio');
    await assert.rejects(db.rpc(sind, 'resident_password_reset_check', { p_tenant: A, p_user: both }), /outro condomínio/, 'conta compartilhada entre condomínios');
    await assert.rejects(db.rpc(sind, 'resident_password_reset_check', { p_tenant: A, p_user: sind }), /não encontrado/, 'equipe não usa este caminho');
    await assert.rejects(db.rpc(mor, 'resident_password_reset_check', { p_tenant: A, p_user: mor }), /Somente quem aprova/);
  } finally { await db.raw.close(); }
});
