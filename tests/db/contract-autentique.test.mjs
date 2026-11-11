// Migration 20261111000100: contrato v1.0 publicável com campos do condomínio, aceite com endereço,
// assinatura bilateral (estado vindo da API, gravado por service_role), PDF assinado imutável e e-mail às partes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const LEGAL = { razao_social: 'Empresa Exemplo de Teste Ltda', cnpj: '11222333000181', endereco: 'Rua de Teste, 100, Cidade Exemplo',
  email_contato: 'contato@exemplo.invalid', canal_privacidade: 'privacidade@exemplo.invalid', encarregado: 'Pessoa Encarregada Teste',
  foro: 'Comarca de Teste', representante: 'Representante Teste', horario_suporte: 'Dias úteis (teste)', disponibilidade: 'Teste' };
const svc = (db, fn, args) => db.service(`select public.${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, Object.values(args)).then((r) => r[0].r);

test('contrato v1.0: publica com campos do condomínio, aceita com endereço, assinatura bilateral e escopo', async () => {
  const db = await createDb();
  db.setNow('2026-11-11T12:00:00Z');
  await db.sql('update plans set published = true');
  const owner = await db.createUser('owner@legal.invalid');
  await db.sql("insert into platform_admins(user_id, role) values ($1, 'owner')", [owner]);
  const sind = await db.createUser('sindico@a.invalid'), outro = await db.createUser('sindico@b.invalid');
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `Cond ${slug}`, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'profissional', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sind, 'ca-a', '11444777000161'), B = await prov(outro, 'ca-b', '11222333000181');

  // Modelo v1.0 com {{CONDOMINIO_*}}: publicável (campos do condomínio não bloqueiam); {{FORO}} da contratada ainda bloqueia sem dado.
  await db.rpc(owner, 'platform_legal_entity_set', { p: JSON.stringify(LEGAL) });
  const md = '# Contrato\n\nCONTRATANTE: {{CONDOMINIO_NOME}}, CNPJ {{CONDOMINIO_CNPJ}}, em {{CONDOMINIO_ENDERECO}}, síndico {{SINDICO_NOME}} CPF {{SINDICO_CPF}}.\n\nForo: {{FORO}}.';
  const d = await db.rpc(owner, 'platform_legal_doc_save', { p_id: null, p_kind: 'contrato_saas', p_version: '1.0', p_content: md, p_summary: null, p_change_note: null, p_material: true });
  for (const to of ['review', 'approved', 'published']) await db.rpc(owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: to, p_note: null });
  const pub = await db.rpc(null, 'legal_document_current', { p_kind: 'contrato_saas' });
  assert.match(pub.content_md, /Foro: Comarca de Teste/); assert.match(pub.content_md, /\{\{CONDOMINIO_NOME\}\}/);

  const accept = (extra = {}) => svc(db, 'contract_accept_v2', { p_actor: sind, p_tenant: A, p_document_sha256: pub.sha256, p_accepted: true,
    p_plan_code: 'profissional', p_cycle: 'monthly', p_proposal: null, p_contractor_name: 'Cond A', p_contractor_document: '11444777000161',
    p_contractor_address: 'Rua das Flores, 10, Centro, São Paulo/SP, 01000-000', p_rep_name: 'Síndica Teste', p_rep_cpf: '52998224725',
    p_rep_email: 'sindico@a.invalid', p_rep_phone: '11999990000', p_rep_role: 'Síndica', p_rep_authority: 'Eleita em assembleia (teste)',
    p_ip: '203.0.113.7', p_user_agent: 'teste', ...extra });
  await assert.rejects(accept({ p_rep_cpf: '12345678900' }), /CPF do síndico inválido/);
  await assert.rejects(accept({ p_rep_phone: null }), /WhatsApp do síndico/);
  await assert.rejects(accept({ p_actor: outro }), /faturamento/);
  const acc = await accept();
  const fill = await svc(db, 'contract_fill_data', { p_acceptance: acc.id });
  assert.equal(fill.contractor_address, 'Rua das Flores, 10, Centro, São Paulo/SP, 01000-000');
  assert.equal(fill.signature.contract_status, 'pending_send');
  assert.ok(fill.trial_ends_at, 'período de teste vem da assinatura');

  // Envio registrado uma vez.
  await svc(db, 'contract_signature_prepared', { p_acceptance: acc.id, p_text_sha256: 'c'.repeat(64) });
  const sent = await svc(db, 'contract_signature_sent', { p_acceptance: acc.id, p_document_id: 'docABC12345', p_contractor_id: 'sig-c', p_contractor_url: 'https://assina.ae/c',
    p_owner_id: 'sig-o', p_owner_url: 'https://assina.ae/o', p_owner_name: 'Contratada', p_owner_email: 'Dono@Exemplo.invalid', p_sandbox: true });
  assert.equal(sent.contract_status, 'awaiting_signatures');
  await assert.rejects(svc(db, 'contract_signature_sent', { p_acceptance: acc.id, p_document_id: 'docOUTRO123', p_contractor_id: 'x', p_contractor_url: null,
    p_owner_id: 'y', p_owner_url: null, p_owner_name: 'x', p_owner_email: 'x@x.invalid', p_sandbox: false }), /já enviado/);
  assert.equal(await svc(db, 'contract_signature_by_document', { p_document_id: 'docABC12345' }), acc.id);

  // Síndico vê status e o próprio link; outro condomínio não.
  const st = await db.rpc(sind, 'contract_signature_status', { p_tenant: A });
  assert.equal(st[0].sign_url, 'https://assina.ae/c');
  await assert.rejects(db.rpc(outro, 'contract_signature_status', { p_tenant: A }), /permiss/i);
  assert.deepEqual(await db.rpc(outro, 'contract_signature_status', { p_tenant: B }), []);

  // Síndico assina: contrato vira vigente (substitui o código por e-mail); repetir é idempotente.
  const s1 = await svc(db, 'contract_signature_sync', { p_acceptance: acc.id, p_contractor_signed_at: '2026-11-11T12:05:00Z', p_owner_signed_at: null, p_rejected_at: null, p_rejected_reason: null });
  assert.equal(s1.contract_status, 'signed_by_contractor'); assert.equal(s1.newly_contractor_signed, true);
  const [a1] = await db.sql('select status, email_verified_at from contract_acceptances where id=$1', [acc.id]);
  assert.equal(a1.status, 'active');
  const again = await svc(db, 'contract_signature_sync', { p_acceptance: acc.id, p_contractor_signed_at: '2026-11-11T12:05:00Z', p_owner_signed_at: null, p_rejected_at: null, p_rejected_reason: null });
  assert.equal(again.newly_contractor_signed, false);
  await assert.rejects(svc(db, 'contract_signature_signed_pdf', { p_acceptance: acc.id, p_path: `${A}/contracts/${acc.id}/contrato-assinado-1-0.pdf`, p_sha256: 'd'.repeat(64) }), /ainda não assinado/);

  // Contratada assina: concluído; PDF final gravado uma vez e e-mail às duas partes.
  const s2 = await svc(db, 'contract_signature_sync', { p_acceptance: acc.id, p_contractor_signed_at: null, p_owner_signed_at: '2026-11-11T13:00:00Z', p_rejected_at: null, p_rejected_reason: null });
  assert.equal(s2.contract_status, 'fully_signed'); assert.equal(s2.newly_fully_signed, true);
  assert.equal(new Date(s2.contractor_signed_at).toISOString(), '2026-11-11T12:05:00.000Z', 'assinatura anterior preservada');
  await assert.rejects(svc(db, 'contract_signature_signed_pdf', { p_acceptance: acc.id, p_path: `${B}/contracts/${acc.id}/x-assinado.pdf`, p_sha256: 'd'.repeat(64) }), /PDF inválido/);
  await svc(db, 'contract_signature_signed_pdf', { p_acceptance: acc.id, p_path: `${A}/contracts/${acc.id}/contrato-assinado-1-0.pdf`, p_sha256: 'd'.repeat(64) });
  const jobs = await db.sql("select recipient from notification_jobs where event='contract_signed' order by recipient");
  assert.deepEqual(jobs.map((j) => j.recipient), ['dono@exemplo.invalid', 'sindico@a.invalid']);
  const [{ ok }] = await db.service("select app.notification_allowed(j) ok from notification_jobs j where event='contract_signed' limit 1");
  assert.equal(ok, true);
  await assert.rejects(db.service("update contract_signatures set signed_pdf_sha256 = $1 where acceptance_id = $2", ['e'.repeat(64), acc.id]), /imutáveis/);
  await assert.rejects(db.service('delete from contract_signatures where acceptance_id = $1', [acc.id]), /permanente/);
  const files = await svc(db, 'contract_file_access', { p_actor: sind, p_acceptance: acc.id });
  assert.equal(files.signed_pdf_path, `${A}/contracts/${acc.id}/contrato-assinado-1-0.pdf`);
  await assert.rejects(svc(db, 'contract_file_access', { p_actor: outro, p_acceptance: acc.id }), /não encontrado/);
  const audit = await db.sql("select action from audit_logs where target_id=$1 and action like 'contract.%' order by id", [acc.id]);
  for (const a of ['contract.accepted', 'contract.sent_for_signature', 'contract.signed_by_contractor', 'contract.fully_signed']) assert.ok(audit.some((x) => x.action === a), a);

  // Admin Master vê o link da Contratada só enquanto não assinou.
  const pl = await db.rpc(owner, 'platform_contract_signatures');
  assert.equal(pl[0].contract_status, 'fully_signed'); assert.equal(pl[0].owner_sign_url, null);
  await assert.rejects(db.rpc(sind, 'platform_contract_signatures'), /restrito/);

  // Sem sessão e sem service_role, nada é chamável; tabelas sem leitura direta.
  for (const q of ['select public.contract_signature_sync($1::uuid,null,null,null,null)', 'select public.contract_fill_data($1::uuid)'])
    await assert.rejects(db.as(sind, q, [acc.id]), /permission denied/);
  await assert.rejects(db.as(sind, 'select * from contract_signatures'), /permission denied/);
  await assert.rejects(db.as(null, 'select * from autentique_webhook_events'), /permission denied/);
  await db.raw.close();
});
