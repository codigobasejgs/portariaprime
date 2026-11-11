/**
 * Contratação eletrônica (mesma função de /api/billing; limite de funções da Vercel).
 *   POST /api/billing/contract_accept  { tenantId, documentSha256, accepted:true, plan|proposal, contratante, representante }
 *   POST /api/billing/contract_verify  { acceptanceId, code }       -> confirma o e-mail do representante
 *   POST /api/billing/contract_code    { acceptanceId }             -> novo código (limitado)
 *   POST /api/billing/contract_pdf     { acceptanceId }             -> URL assinada (5 min) do PDF original
 *   POST /api/billing/contract_resend  { acceptanceId }             -> reenvia a MESMA cópia (mesmo PDF/hash)
 * Sessão validada no Auth; o banco recebe o id do usuário (p_actor) e revalida permissão
 * de faturamento. IP e user-agent vêm do servidor (finalidade/retenção em docs/CONTRATACAO.md).
 * Preço SEMPRE recalculado no banco; nada do navegador. Aceite não gera nem confirma pagamento.
 */
import { randomInt, createHash } from 'node:crypto';
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { sendEmail } from '../_lib/channels.js';
import { esc } from '../_lib/templates.js';
import { renderContractPdf } from '../_lib/contract-pdf.js';
import { sendForSignature, syncSignature } from '../_lib/contract-sign.js';

const str = (v: unknown, min: number, max: number, label: string) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${label} inválido.`);
  return s;
};
const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

/** Validação de entrada (exportada para teste). Não decide preço nem permissão. */
export function parseAcceptInput(b: any) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'Dados inválidos.');
  if (!isUuid(b.tenantId)) throw new HttpError(400, 'Condomínio inválido.');
  if (b.accepted !== true) throw new HttpError(400, 'Marque a caixa de aceite para continuar.');
  if (typeof b.documentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.documentSha256)) throw new HttpError(400, 'Versão do documento inválida.');
  const proposal = typeof b.proposal === 'string' && b.proposal.trim() ? str(b.proposal, 8, 200, 'Proposta') : null;
  const plan = proposal ? null : str(b.plan, 2, 30, 'Plano');
  const cycle = proposal ? null : str(b.cycle, 6, 10, 'Ciclo');
  if (cycle && !['monthly', 'quarterly', 'yearly'].includes(cycle)) throw new HttpError(400, 'Ciclo inválido.');
  if ('amountCents' in b || 'price' in b) throw new HttpError(400, 'O preço é definido pelo servidor.');
  const contractorDocument = digits(b.contractorDocument);
  if (![11, 14].includes(contractorDocument.length)) throw new HttpError(400, 'CNPJ do condomínio (ou CPF do responsável) inválido.');
  const cpf = digits(b.representativeCpf);
  if (cpf && cpf.length !== 11) throw new HttpError(400, 'CPF do representante inválido.');
  const email = str(b.representativeEmail, 5, 200, 'E-mail do representante').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'E-mail do representante inválido.');
  const phone = digits(b.representativePhone);
  if (phone && (phone.length < 10 || phone.length > 13)) throw new HttpError(400, 'Telefone do representante inválido.');
  // v1.0 (assinatura na Autentique): endereço, CPF e WhatsApp do síndico obrigatórios.
  const contractorAddress = typeof b.contractorAddress === 'string' && b.contractorAddress.trim() ? str(b.contractorAddress, 10, 300, 'Endereço do condomínio') : null;
  if (contractorAddress && (!cpf || !phone)) throw new HttpError(400, 'Informe CPF e WhatsApp do síndico para assinar o contrato.');
  return {
    tenantId: b.tenantId as string, documentSha256: b.documentSha256 as string, plan, cycle, proposal, contractorAddress,
    contractorName: str(b.contractorName, 2, 200, 'Nome do contratante'), contractorDocument,
    representativeName: str(b.representativeName, 3, 160, 'Nome do representante'), representativeCpf: cpf || null,
    representativeEmail: email, representativePhone: phone || null,
    representativeRole: str(b.representativeRole, 2, 120, 'Cargo do representante'),
    representativeAuthority: str(b.representativeAuthority, 5, 300, 'Declaração de poderes'),
  };
}

/** IP do cliente informado pela borda da Vercel; formato inesperado = não registrado. */
export function clientIp(request: Request): string | null {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return /^[0-9A-Fa-f:.]{2,64}$/.test(ip) ? ip : null;
}

/** Gera e grava o PDF uma única vez (o banco recusa trocar um PDF pronto). */
export async function ensureContractPdf(svc: any, acceptanceId: string) {
  const { data, error } = await svc.rpc('contract_pdf_data', { p_acceptance: acceptanceId });
  if (error || !data) throw new Error('dados do aceite indisponíveis');
  if (data.pdf_status === 'ready') return { path: data.pdf_path as string, sha256: data.pdf_sha256 as string };
  const bytes = await renderContractPdf(data);
  const path = `${data.tenant_id}/contracts/${data.id}/contrato-${String(data.document_version).replace(/[^0-9A-Za-z-]/g, '-')}.pdf`;
  const up = await svc.storage.from('tenant-contracts').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error(`storage: ${up.error.message}`);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const { data: done, error: ce } = await svc.rpc('complete_contract_pdf', { p_acceptance: data.id, p_path: path, p_sha256: sha });
  if (ce) throw new Error(ce.message);
  return { path: done.path as string, sha256: done.sha256 as string };
}

/** Código por e-mail. Sem provedor configurado: não envia e não finge verificação. */
async function sendCode(svc: any, actor: string, acceptanceId: string, email: string): Promise<'sent' | 'unavailable' | 'failed'> {
  if (!optionalEnv('RESEND_API_KEY') || !optionalEnv('RESEND_FROM_EMAIL')) return 'unavailable';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const { error } = await svc.rpc('contract_set_code', { p_actor: actor, p_acceptance: acceptanceId, p_code: code });
  if (error) rpcError(error);
  const r = await sendEmail(email, 'Código de confirmação do contrato — Portaria Prime',
    `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#18283A"><p>Seu código para confirmar o aceite do contrato da Portaria Prime é:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px">${esc(code)}</p><p>Ele vale por 15 minutos. Se você não reconhece este pedido, ignore este e-mail.</p></body></html>`);
  return r.status === 'accepted' ? 'sent' : 'failed';
}

const VERIFY_MSG = {
  sent: 'Enviamos um código de 6 dígitos para o e-mail do representante. Ele vale 15 minutos.',
  unavailable: 'O envio de e-mails ainda não está configurado nesta instalação. O aceite foi registrado, mas fica pendente de verificação do e-mail do representante até o envio ser habilitado; nenhuma verificação foi simulada.',
  failed: 'Não conseguimos enviar o código agora. O aceite ficou registrado como pendente de verificação; peça um novo código em instantes.',
};

export async function contractAction(action: string, request: Request): Promise<Response> {
  const body = await readJson(request, 16 * 1024);
  const { user } = await requireUser(request);
  const svc = serviceClient();

  if (action === 'contract_accept') {
    const i = parseAcceptInput(body);
    const { data, error } = await svc.rpc(i.contractorAddress ? 'contract_accept_v2' : 'contract_accept', {
      p_actor: user.id, p_tenant: i.tenantId, p_document_sha256: i.documentSha256, p_accepted: true,
      p_plan_code: i.plan, p_cycle: i.cycle, p_proposal: i.proposal,
      p_contractor_name: i.contractorName, p_contractor_document: i.contractorDocument,
      ...(i.contractorAddress ? { p_contractor_address: i.contractorAddress } : {}),
      p_rep_name: i.representativeName, p_rep_cpf: i.representativeCpf, p_rep_email: i.representativeEmail, p_rep_phone: i.representativePhone,
      p_rep_role: i.representativeRole, p_rep_authority: i.representativeAuthority,
      p_ip: clientIp(request), p_user_agent: (request.headers.get('user-agent') || '').slice(0, 400) || null,
    });
    if (error) rpcError(error);
    // O aceite já está registrado; falha no PDF é recuperável por /contract_pdf.
    let pdf: { sha256: string } | null = null;
    try { pdf = await ensureContractPdf(svc, data.id); } catch (e: any) { console.error('[contract_pdf]', e?.message || e); }
    // v1.0: a assinatura na Autentique confirma o síndico (o link vai ao e-mail dele); sem código por e-mail.
    if (i.contractorAddress) {
      const sign = await sendForSignature(svc, data.id);
      return json({ acceptanceId: data.id, status: data.status, kind: data.kind, acceptedAt: data.accepted_at, documentVersion: data.document_version,
        documentSha256: data.document_sha256, terms: data.terms, pdfSha256: pdf?.sha256 || null, signature: sign, verification: 'autentique',
        message: sign.status === 'awaiting_signatures' ? 'Contrato enviado para assinatura na Autentique. O link também foi enviado ao e-mail do síndico.'
          : sign.status === 'not_configured' ? 'Aceite registrado. A assinatura eletrônica ainda não está configurada; a Portaria Prime enviará o link de assinatura.'
          : 'Aceite registrado, mas o envio para assinatura falhou. Use "Atualizar status" em instantes.' });
    }
    const verification = await sendCode(svc, user.id, data.id, data.representative_email);
    return json({ acceptanceId: data.id, status: data.status, kind: data.kind, acceptedAt: data.accepted_at, documentVersion: data.document_version,
      documentSha256: data.document_sha256, terms: data.terms, pdfSha256: pdf?.sha256 || null, verification, message: VERIFY_MSG[verification] });
  }

  if (!isUuid(body.acceptanceId)) throw new HttpError(400, 'Aceite inválido.');
  const id = body.acceptanceId as string;

  if (action === 'contract_verify') {
    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new HttpError(400, 'Informe o código de 6 dígitos.');
    const { data, error } = await svc.rpc('contract_verify', { p_actor: user.id, p_acceptance: id, p_code: body.code });
    if (error) rpcError(error);
    return json(data, data.error ? 422 : 200);
  }
  if (action === 'contract_code') {
    const { data, error } = await svc.rpc('contract_pdf_data', { p_acceptance: id });
    if (error || !data) throw new HttpError(404, 'Aceite não encontrado.');
    const verification = await sendCode(svc, user.id, id, data.representative_email);
    return json({ verification, message: VERIFY_MSG[verification] });
  }
  if (action === 'contract_pdf') {
    const { data, error } = await svc.rpc('contract_pdf_access', { p_actor: user.id, p_acceptance: id });
    if (error) rpcError(error);
    const path = data.status === 'ready' ? data.path : (await ensureContractPdf(svc, id)).path;
    const { data: s, error: se } = await svc.storage.from('tenant-contracts').createSignedUrl(path, 300, { download: `contrato-portaria-prime-${id.slice(0, 8)}.pdf` });
    if (se || !s) throw new HttpError(502, 'Não foi possível abrir o PDF agora.');
    return json({ url: s.signedUrl });
  }
  // "Já assinei / Atualizar status": consulta a Autentique agora (reenvia se o primeiro envio falhou).
  if (action === 'contract_sync') {
    const { data, error } = await svc.rpc('contract_file_access', { p_actor: user.id, p_acceptance: id });
    if (error) rpcError(error);
    if (!data.autentique_document_id) return json(await sendForSignature(svc, id));
    try { return json(await syncSignature(svc, id)); }
    catch (e: any) { console.error('[autentique.sync]', e?.message || e); throw new HttpError(502, 'Não foi possível consultar a Autentique agora. Tente em instantes.'); }
  }
  if (action === 'contract_signed_pdf' || action === 'contract_original_pdf') {
    const { data, error } = await svc.rpc('contract_file_access', { p_actor: user.id, p_acceptance: id });
    if (error) rpcError(error);
    const signed = action === 'contract_signed_pdf';
    const path = signed ? data.signed_pdf_path : data.pdf_path;
    if (!path) throw new HttpError(409, signed ? 'O PDF assinado pelas duas partes ainda não está disponível.' : 'O PDF ainda está sendo gerado.');
    const { data: s, error: se } = await svc.storage.from('tenant-contracts').createSignedUrl(path, 300, { download: `contrato-${signed ? 'assinado-' : ''}${id.slice(0, 8)}.pdf` });
    if (se || !s) throw new HttpError(502, 'Não foi possível abrir o PDF agora.');
    return json({ url: s.signedUrl });
  }
  if (action === 'contract_resend') {
    const { data, error } = await svc.rpc('contract_resend_copy', { p_actor: user.id, p_acceptance: id });
    if (error) rpcError(error);
    return json(data);
  }
  throw new HttpError(404, 'Ação desconhecida.');
}
