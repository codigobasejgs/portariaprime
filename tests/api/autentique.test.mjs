// Contrato v1.0 + Autentique: preenchimento sem sobras, PDF real, envio com 2 signatários (multipart),
// webhook com HMAC, idempotência, double-check na API e payload inválido. Rede e Supabase simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseDraft } from '../../src/lib/legal-text.ts';
import { fillContract, reaisExtenso } from '../../api/_lib/contract-fill.ts';
import { renderOfficialContract } from '../../api/_lib/contract-official-pdf.ts';
import { verifyWebhookSignature } from '../../api/_lib/autentique.ts';
import { sendForSignature } from '../../api/_lib/contract-sign.ts';
import { parseAutentiqueEvent } from '../../api/webhooks/_autentique.ts';
import { POST as webhook } from '../../api/webhooks/infinitepay.ts';

const ACC = '99999999-2222-4333-8444-555555555555', T = '11111111-2222-4333-8444-555555555555';
const { meta, body } = parseDraft(readFileSync('docs/legal/contrato-saas.md', 'utf8'));
const data = { id: ACC, tenant_id: T, accepted_at: '2026-11-11T15:00:00Z', timezone: 'America/Sao_Paulo', document_version: '1.0', document_md: body,
  contractor_name: 'Condomínio Residencial Exemplo', contractor_document: '11444777000161', contractor_address: 'Rua das Flores, 10, Centro, São Paulo/SP, 01000-000',
  representative_name: 'Maria Síndica', representative_cpf: '52998224725', representative_email: 'maria@exemplo.invalid', representative_phone: '11999990000',
  terms: { source: 'catalog', plan_name: 'Profissional', plan_code: 'profissional', cycle: 'monthly', amount_cents: 16900, limits: { max_units: 400, max_concierges: 2 } },
  trial_started_at: '2026-11-11T15:00:00Z', trial_ends_at: '2026-12-11T15:00:00Z' };

test('contrato v1.0 oficial: 24 cláusulas, 2 anexos, contratada real, sem "minuta"', () => {
  assert.equal(meta.version, '1.0');
  assert.equal((body.match(/^## CLÁUSULA \d+ª/gm) || []).length, 24);
  assert.match(body, /## ANEXO I –/); assert.match(body, /## ANEXO II –/);
  assert.match(body, /59\.760\.458\/0001-91 MARCO ANTONIO BOGGIAN/);
  assert.doesNotMatch(body, /minuta|rascunho|\.example/i);
});

test('preenchimento: nenhum {{...}} sobra; preço vem do servidor; extenso correto', () => {
  const { text, sha256 } = fillContract(data);
  assert.doesNotMatch(text, /\{\{|\}\}|\.example/);
  for (const s of ['Condomínio Residencial Exemplo', '11.444.777/0001-61', 'Rua das Flores, 10', 'Maria Síndica', '529.982.247-25', '(11) 99999-0000',
    'R$ 169,00 (cento e sessenta e nove reais)', 'até 400 unidades e 2 portaria(s)', '11/11/2026', '11/12/2026', 'São Paulo/SP, 11 de novembro de 2026', 'Dia 11 de cada mês'])
    assert.ok(text.includes(s), s);
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(reaisExtenso(36900), 'trezentos e sessenta e nove reais');
  assert.equal(reaisExtenso(100), 'um real');
  assert.equal(reaisExtenso(121350), 'mil duzentos e treze reais e cinquenta centavos');
  assert.throws(() => fillContract({ ...data, contractor_address: '' }), /CONDOMINIO_ENDERECO/);
});

test('PDF oficial: arquivo real com página de assinaturas e posições das duas partes', async () => {
  const { bytes, positions } = await renderOfficialContract(fillContract(data).text, { contractor: 'Cond · Rep', contractorDoc: 'CNPJ', owner: 'Contratada' });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  assert.ok(bytes.length > 20000);
  const last = positions.contractor[0].z;
  assert.ok(last > 5 && positions.owner[0].z === last);
  for (const p of [...positions.contractor, ...positions.owner]) { assert.ok(+p.x > 0 && +p.x < 100); assert.ok(+p.y > 0 && +p.y < 100); }
  assert.ok(+positions.owner[0].y > +positions.contractor[0].y, 'Contratada abaixo da Contratante');
});

function env(vars) {
  const saved = {}; for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };

test('envio: sem token não simula; com token cria documento com 2 signatários e grava ids/links', async () => {
  const fetch0 = globalThis.fetch; const calls = [];
  const sig = { autentique_document_id: null, contract_status: 'pending_send' };
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push({ u, init });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (u.endsWith('/rpc/contract_fill_data')) return Response.json({ ...data, signature: sig });
    if (u.endsWith('/rpc/contract_signature_failed')) return Response.json(null);
    if (u.endsWith('/rpc/contract_signature_prepared')) return Response.json(null);
    if (u.endsWith('/rpc/contract_signature_sent')) return Response.json({ ...body, contract_status: 'awaiting_signatures' });
    if (u.includes('autentique.com.br')) return Response.json({ data: { createDocument: { id: 'doc12345678', signatures: [
      { public_id: 'pc', email: 'maria@exemplo.invalid', link: { short_link: 'https://assina.ae/c' } },
      { public_id: 'po', email: 'dono@exemplo.invalid', link: { short_link: 'https://assina.ae/o' } }] } } });
    throw new Error(`inesperado ${u}`);
  };
  let restore = env({ ...SB, AUTENTIQUE_API_TOKEN: undefined, AUTENTIQUE_OWNER_EMAIL: undefined });
  try {
    const { serviceClient } = await import('../../api/_lib/supabase.ts');
    assert.deepEqual(await sendForSignature(serviceClient(), ACC), { status: 'not_configured' });
    assert.ok(!calls.some((c) => c.u.includes('autentique')), 'sem configuração não chama a Autentique');
    restore(); restore = env({ ...SB, AUTENTIQUE_API_TOKEN: 'tok', AUTENTIQUE_OWNER_EMAIL: 'Dono@Exemplo.invalid', AUTENTIQUE_SANDBOX: 'true' });
    const r = await sendForSignature(serviceClient(), ACC);
    assert.deepEqual(r, { status: 'awaiting_signatures', signUrl: 'https://assina.ae/c' });
    const call = calls.find((c) => c.u.includes('autentique'));
    assert.equal(call.init.headers.Authorization, 'Bearer tok');
    const ops = JSON.parse(call.init.body.get('operations'));
    assert.match(ops.query, /createDocument\(sandbox: \$sandbox/);
    assert.equal(ops.variables.sandbox, true);
    assert.deepEqual(ops.variables.signers.map((s) => [s.email, s.action, s.positions.map((p) => p.element).join('+')]),
      [['maria@exemplo.invalid', 'SIGN', 'SIGNATURE+DATE'], ['dono@exemplo.invalid', 'SIGN', 'SIGNATURE+DATE']]);
    assert.equal(call.init.body.get('map'), '{"file":["variables.file"]}');
    assert.equal(Buffer.from(new Uint8Array(await call.init.body.get('file').arrayBuffer()).slice(0, 5)).toString(), '%PDF-');
    const sent = JSON.parse(calls.find((c) => c.u.endsWith('/rpc/contract_signature_sent')).init.body);
    assert.deepEqual([sent.p_document_id, sent.p_contractor_id, sent.p_owner_id, sent.p_owner_url], ['doc12345678', 'pc', 'po', 'https://assina.ae/o']);
  } finally { globalThis.fetch = fetch0; restore(); }
});

test('webhook: HMAC, payload inválido, duplicado e double-check na API antes de mudar estado', async () => {
  const raw = (id, type, doc) => JSON.stringify({ id: 'w1', object: 'webhook', event: { id, object: 'event', type,
    data: type.startsWith('document.') ? { object: { id: doc } } : { public_id: 'pc', object: 'signature', document: doc } } });
  assert.deepEqual(parseAutentiqueEvent(JSON.parse(raw('ev-00000001', 'signature.accepted', 'doc12345678'))), { eventId: 'ev-00000001', type: 'signature.accepted', documentId: 'doc12345678' });
  assert.equal(parseAutentiqueEvent({ event: { id: 'x', type: 'signature.accepted' } }), null);
  const secret = 's3cr3t';
  const sign = (b) => createHmac('sha256', secret).update(b).digest('hex');
  assert.equal(verifyWebhookSignature('a', sign('a'), secret), true);
  assert.equal(verifyWebhookSignature('a', sign('b'), secret), false);
  assert.equal(verifyWebhookSignature('a', null, secret), false);

  const fetch0 = globalThis.fetch; const seen = new Set(); const calls = [];
  const state = { contractor: null };
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push(u);
    if (u.includes('/rest/v1/autentique_webhook_events') && init.method === 'POST') {
      const id = JSON.parse(init.body)[0]?.event_id ?? JSON.parse(init.body).event_id;
      const dup = seen.has(id); seen.add(id); return Response.json(dup ? [] : [{ event_id: id }]);
    }
    if (u.includes('/rest/v1/autentique_webhook_events')) return Response.json([]);
    if (u.endsWith('/rpc/contract_signature_by_document')) return Response.json(ACC);
    if (u.endsWith('/rpc/contract_fill_data')) return Response.json({ ...data, signature: { autentique_document_id: 'doc12345678', autentique_contractor_signer_id: 'pc',
      autentique_owner_signer_id: 'po', autentique_owner_sign_url: null, contract_status: 'awaiting_signatures' } });
    if (u.includes('autentique.com.br')) return Response.json({ data: { document: { id: 'doc12345678', files: {}, signatures: [
      { public_id: 'pc', email: 'maria@exemplo.invalid', signed: state.contractor ? { created_at: state.contractor } : null, rejected: null },
      { public_id: 'po', email: 'dono@exemplo.invalid', signed: null, rejected: null }] } } });
    if (u.endsWith('/rpc/contract_signature_sync')) { calls.push(`sync:${JSON.parse(init.body).p_contractor_signed_at}`);
      return Response.json({ contract_status: JSON.parse(init.body).p_contractor_signed_at ? 'signed_by_contractor' : 'awaiting_signatures', newly_contractor_signed: false }); }
    throw new Error(`inesperado ${u}`);
  };
  const restore = env({ ...SB, AUTENTIQUE_API_TOKEN: 'tok', AUTENTIQUE_OWNER_EMAIL: 'dono@exemplo.invalid', AUTENTIQUE_WEBHOOK_SECRET: secret });
  const post = (b, sig = sign(b)) => webhook(new Request('https://app/api/webhooks/infinitepay?a=autentique', { method: 'POST', body: b, headers: { 'x-autentique-signature': sig } }));
  try {
    assert.equal((await post('{"x":1}', sign('{"x":1}'))).status, 400, 'payload inválido');
    const b1 = raw('ev-00000001', 'signature.accepted', 'doc12345678');
    assert.equal((await post(b1, sign('outro'))).status, 401, 'HMAC inválido recusado');
    // Webhook diz "assinado", mas a API ainda não mostra assinatura: nada é marcado como assinado.
    assert.equal((await post(b1)).status, 200);
    assert.ok(calls.includes('sync:null'), 'estado aplicado é o da API, não o do webhook');
    assert.deepEqual(await (await post(b1)).json(), { ok: true, duplicate: true });
    state.contractor = '2026-11-11T16:00:00.000000Z';
    assert.equal((await post(raw('ev-00000002', 'signature.accepted', 'doc12345678'))).status, 200);
    assert.ok(calls.includes('sync:2026-11-11T16:00:00.000000Z'));
  } finally { globalThis.fetch = fetch0; restore(); }
});
