/**
 * Autentique API GraphQL v2 (https://api.autentique.com.br/v2/graphql). Somente servidor.
 *   AUTENTIQUE_API_TOKEN       chave da API (obrigatória para enviar)
 *   AUTENTIQUE_WEBHOOK_SECRET  segredo HMAC do endpoint de webhook (cabeçalho x-autentique-signature)
 *   AUTENTIQUE_OWNER_NAME      nome da Contratada (padrão abaixo)
 *   AUTENTIQUE_OWNER_EMAIL     e-mail que assina como Contratada (obrigatório para enviar)
 *   AUTENTIQUE_SANDBOX         "true" cria documento de teste (não consome crédito; some em dias)
 * Nada aqui decide estado: o banco recebe só o que a API da Autentique confirmou.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { optionalEnv } from './env.js';

const URL_API = 'https://api.autentique.com.br/v2/graphql';
export const OWNER_DEFAULT = 'Marco Antonio Boggian (Portaria Prime - 59.760.458/0001-91)';

export function autentiqueConfig() {
  const token = optionalEnv('AUTENTIQUE_API_TOKEN');
  const ownerEmail = optionalEnv('AUTENTIQUE_OWNER_EMAIL')?.toLowerCase() || null;
  return { token, ownerEmail, ownerName: optionalEnv('AUTENTIQUE_OWNER_NAME') || OWNER_DEFAULT,
    sandbox: optionalEnv('AUTENTIQUE_SANDBOX') === 'true', ready: !!token && !!ownerEmail };
}

async function gql(body: BodyInit, json: boolean) {
  const { token } = autentiqueConfig();
  if (!token) throw new Error('AUTENTIQUE_API_TOKEN não configurado');
  const r = await fetch(URL_API, { method: 'POST', body, signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) } });
  const d: any = await r.json().catch(() => null);
  if (!r.ok || !d || d.errors?.length) throw new Error(`Autentique HTTP ${r.status}: ${String(d?.errors?.[0]?.message || d?.message || 'resposta inválida').slice(0, 200)}`);
  return d.data;
}

export type Signer = { name: string; email: string; positions: { x: string; y: string; z: number; element: 'SIGNATURE' | 'NAME' | 'DATE' }[] };

const CREATE = `mutation CreateDocumentMutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!, $sandbox: Boolean) {
  createDocument(sandbox: $sandbox, document: $document, signers: $signers, file: $file) {
    id name created_at signatures { public_id name email action { name } link { short_link } } } }`;

/** Cria o documento (multipart: operations, map, file) com os signatários na ordem dada. */
export async function createDocument(name: string, pdf: Uint8Array, signers: Signer[], message: string) {
  const { sandbox } = autentiqueConfig();
  const fd = new FormData();
  fd.append('operations', JSON.stringify({ query: CREATE, variables: {
    document: { name, message, refusable: true, stop_on_rejected: true, sortable: false, scrolling_required: true, reminder: 'DAILY',
      configs: { notification_finished: true, notification_signed: true } },
    signers: signers.map((s) => ({ name: s.name, email: s.email, action: 'SIGN', positions: s.positions })), file: null, sandbox } }));
  fd.append('map', JSON.stringify({ file: ['variables.file'] }));
  fd.append('file', new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${name.replace(/[^\w.-]+/g, '-').slice(0, 80)}.pdf`);
  const d = await gql(fd, false);
  const doc = d?.createDocument;
  if (!doc?.id || !Array.isArray(doc.signatures)) throw new Error('Autentique: resposta sem documento');
  return { id: String(doc.id), sandbox, signatures: doc.signatures as { public_id: string; email: string | null; link?: { short_link?: string } | null }[] };
}

/** Link exclusivo do signatário (quando a criação não devolve, ex.: signatário por e-mail). */
export async function signatureLink(publicId: string): Promise<string | null> {
  const d = await gql(JSON.stringify({ query: 'mutation($p: UUID!) { createLinkToSignature(public_id: $p) { short_link } }', variables: { p: publicId } }), true);
  return d?.createLinkToSignature?.short_link || null;
}

export type DocState = { id: string; files: { original?: string | null; signed?: string | null };
  signatures: { public_id: string; email: string | null; signed: string | null; rejected: string | null; reason: string | null }[] };

/** Estado real do documento (fonte de verdade para o webhook e o "Já assinei"). */
export async function getDocument(id: string): Promise<DocState | null> {
  const d = await gql(JSON.stringify({ query: `query($id: UUID!) { document(id: $id) { id files { original signed }
    signatures { public_id email signed { created_at } rejected { created_at reason } } } }`, variables: { id } }), true);
  const doc = d?.document;
  if (!doc) return null;
  return { id: String(doc.id), files: doc.files || {}, signatures: (doc.signatures || []).map((s: any) => ({ public_id: s.public_id, email: s.email || null,
    signed: s.signed?.created_at || null, rejected: s.rejected?.created_at || null, reason: s.rejected?.reason || null })) };
}

/** HMAC-SHA256 do corpo bruto com o segredo do endpoint (cabeçalho x-autentique-signature). */
export function verifyWebhookSignature(raw: string, header: string | null, secret: string | null): boolean {
  if (!header || !secret || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const calc = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(calc, Buffer.from(header, 'hex'));
}

/** Baixa o PDF assinado (link da própria Autentique; nada de URL vinda do webhook). */
export async function downloadSigned(url: string): Promise<Uint8Array> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/(^|\.)autentique\.com\.br$|(^|\.)storage\.googleapis\.com$/.test(u.hostname)) throw new Error('URL de PDF inesperada');
  const { token } = autentiqueConfig();
  const r = await fetch(u, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  const b = new Uint8Array(await r.arrayBuffer());
  if (!r.ok || Buffer.from(b.slice(0, 5)).toString() !== '%PDF-') throw new Error(`PDF assinado indisponível (HTTP ${r.status})`);
  return b;
}
