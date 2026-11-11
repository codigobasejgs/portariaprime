/**
 * Assinatura bilateral do contrato: envio à Autentique, sincronização (webhook / "Já assinei") e
 * conclusão (PDF assinado guardado + e-mail às partes pelo outbox). Estado SEMPRE da API da
 * Autentique; o webhook só dispara a consulta.
 */
import { createHash } from 'node:crypto';
import { autentiqueConfig, createDocument, downloadSigned, getDocument, signatureLink } from './autentique.js';
import { fillContract } from './contract-fill.js';
import { renderOfficialContract } from './contract-official-pdf.js';
import { sendEmail } from './channels.js';
import { appUrl, optionalEnv } from './env.js';
import { esc } from './templates.js';

const fmtDoc = (d: string) => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

async function rpc(svc: any, fn: string, args: Record<string, unknown>) {
  const { data, error } = await svc.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/** Aviso à Contratada (e-mail direto, sem outbox: é operacional, não do condomínio). */
async function notifyOwner(subject: string, html: string) {
  const to = autentiqueConfig().ownerEmail || optionalEnv('PLATFORM_ALERT_EMAIL');
  if (to) await sendEmail(to, subject, `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#18283A">${html}</body></html>`).catch(() => null);
}

/** Envia o aceite à Autentique (uma vez). Sem configuração: marca "not_configured" e não simula nada. */
export async function sendForSignature(svc: any, acceptanceId: string) {
  const d = await rpc(svc, 'contract_fill_data', { p_acceptance: acceptanceId });
  if (!d?.signature) return { status: 'legacy' };
  if (d.signature.autentique_document_id) return { status: d.signature.contract_status };
  const cfg = autentiqueConfig();
  if (!cfg.ready) {
    await rpc(svc, 'contract_signature_failed', { p_acceptance: acceptanceId, p_status: 'not_configured', p_error: 'Assinatura eletrônica ainda não configurada no servidor.' });
    return { status: 'not_configured' };
  }
  try {
    const { text, sha256 } = fillContract(d);
    await rpc(svc, 'contract_signature_prepared', { p_acceptance: acceptanceId, p_text_sha256: sha256 });
    const { bytes, positions } = await renderOfficialContract(text, { contractor: `${d.contractor_name} · Representante: ${d.representative_name}`,
      contractorDoc: `CNPJ/CPF: ${fmtDoc(d.contractor_document)} · CPF do síndico: ${fmtDoc(d.representative_cpf || '')}`, owner: cfg.ownerName });
    const el = (p: { x: string; y: string; z: number }, element: 'SIGNATURE' | 'DATE') => ({ ...p, element });
    const doc = await createDocument(`Contrato Portaria Prime v${d.document_version} - ${d.contractor_name}`.slice(0, 180), bytes, [
      { name: d.representative_name, email: d.representative_email, positions: [el(positions.contractor[0], 'SIGNATURE'), el(positions.contractor[1], 'DATE')] },
      { name: cfg.ownerName, email: cfg.ownerEmail!, positions: [el(positions.owner[0], 'SIGNATURE'), el(positions.owner[1], 'DATE')] },
    ], 'Contrato Portaria Prime preenchido com os dados do condomínio. Leia até o fim e assine.');
    const find = (email: string) => doc.signatures.find((s) => (s.email || '').toLowerCase() === email.toLowerCase());
    const c = find(d.representative_email), o = find(cfg.ownerEmail!);
    if (!c || !o) throw new Error('Autentique não devolveu os dois signatários');
    const cUrl = c.link?.short_link || await signatureLink(c.public_id).catch(() => null);
    const oUrl = o.link?.short_link || await signatureLink(o.public_id).catch(() => null);
    await rpc(svc, 'contract_signature_sent', { p_acceptance: acceptanceId, p_document_id: doc.id, p_contractor_id: c.public_id, p_contractor_url: cUrl,
      p_owner_id: o.public_id, p_owner_url: oUrl, p_owner_name: cfg.ownerName, p_owner_email: cfg.ownerEmail, p_sandbox: doc.sandbox });
    return { status: 'awaiting_signatures', signUrl: cUrl };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 400);
    await rpc(svc, 'contract_signature_failed', { p_acceptance: acceptanceId, p_status: 'send_failed', p_error: msg }).catch(() => null);
    console.error('[autentique.send]', msg);
    return { status: 'send_failed' };
  }
}

/** Consulta a Autentique e aplica o estado. Conclui (PDF assinado + e-mails) quando as duas partes assinaram. */
export async function syncSignature(svc: any, acceptanceId: string) {
  const d = await rpc(svc, 'contract_fill_data', { p_acceptance: acceptanceId });
  const s = d?.signature;
  if (!s?.autentique_document_id) return { status: s?.contract_status || 'legacy' };
  const doc = await getDocument(s.autentique_document_id);
  if (!doc) throw new Error('Documento não encontrado na Autentique');
  const by = (id: string) => doc.signatures.find((x) => x.public_id === id);
  const c = by(s.autentique_contractor_signer_id), o = by(s.autentique_owner_signer_id);
  const rej = [c, o].find((x) => x?.rejected);
  const out = await rpc(svc, 'contract_signature_sync', { p_acceptance: acceptanceId, p_contractor_signed_at: c?.signed || null,
    p_owner_signed_at: o?.signed || null, p_rejected_at: rej?.rejected || null, p_rejected_reason: rej ? `${rej === c ? 'Contratante' : 'Contratada'}: ${rej.reason || 'sem motivo informado'}` : null });
  const base = (() => { try { return appUrl(); } catch { return 'https://portariaprime.com.br'; } })();
  if (out.newly_contractor_signed && !o?.signed && s.autentique_owner_sign_url) {
    await notifyOwner(`Contrato assinado pelo condomínio — ${esc(d.contractor_name)}`,
      `<p>${esc(d.contractor_name)} assinou o contrato v${esc(d.document_version)}. Falta a assinatura da Portaria Prime (Contratada).</p>
       <p><a href="${esc(s.autentique_owner_sign_url)}">Assinar como Contratada na Autentique</a> · <a href="${base}/admin">Admin Master</a></p>`);
  }
  if (out.contract_status === 'rejected' && rej) {
    await notifyOwner(`Contrato recusado — ${esc(d.contractor_name)}`, `<p>Assinatura recusada (${esc(out.rejected_reason || '')}). Gere uma nova via se necessário.</p>`);
  }
  if (out.contract_status === 'fully_signed' && !out.signed_pdf_path && doc.files.signed) {
    const bytes = await downloadSigned(doc.files.signed);
    const path = `${d.tenant_id}/contracts/${acceptanceId}/contrato-assinado-${String(d.document_version).replace(/[^0-9A-Za-z-]/g, '-')}.pdf`;
    const up = await svc.storage.from('tenant-contracts').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(`storage: ${up.error.message}`);
    await rpc(svc, 'contract_signature_signed_pdf', { p_acceptance: acceptanceId, p_path: path, p_sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { status: out.contract_status, contractorSignedAt: out.contractor_signed_at, ownerSignedAt: out.owner_signed_at };
}
