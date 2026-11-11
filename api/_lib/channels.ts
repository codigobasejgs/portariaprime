/**
 * Envio real por canal. Cada função devolve o status honesto:
 *   accepted = provedor aceitou (não é confirmação de entrega)
 *   failed   = erro (com retry pela fila)
 *   disabled = canal não configurado/indisponível (nunca vira "sucesso")
 */
import webpush from 'web-push';
import { optionalEnv } from './env.js';

export type SendResult = { status: 'accepted' | 'failed' | 'disabled'; ref?: string; error?: string; gone?: boolean; permanent?: boolean };

export type Attachment = { filename: string; content: Uint8Array };

/**
 * Remetente: o endereço é sempre o de RESEND_FROM_EMAIL (domínio verificado); só o nome de exibição pode
 * identificar o condomínio ("Condomínio X via Portaria Prime"). Sem caracteres que quebrem o cabeçalho.
 */
export function fromHeader(base: string, displayName?: string | null): string {
  const addr = base.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || base.trim();
  const name = String(displayName || '').replace(/["<>\\\r\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name ? `"${name} via Portaria Prime" <${addr}>` : base;
}

/**
 * E-mail: Resend (principal) e Brevo (reserva, outro provedor — não é conta duplicada). A reserva só entra quando o
 * Resend recusa ANTES de aceitar: cota esgotada (429), sem configuração ou 5xx. Timeout/erro de rede depois do envio
 * é ambíguo e não vai para a reserva (evita e-mail duplicado). 422 = destinatário recusado: nenhum provedor resolve.
 * ponytail: decide pela resposta de cada envio, sem contador próprio de cota. Somar contador se a latência do 429 incomodar.
 */
export async function sendEmail(to: string, subject: string, html: string, attachment?: Attachment, senderName?: string | null,
  opts: { text?: string; idempotencyKey?: string } = {}): Promise<SendResult> {
  const r = await sendResend(to, subject, html, attachment, senderName, opts);
  if (r.status === 'accepted' || r.permanent || r.ambiguous) return strip(r);
  const b = await sendBrevo(to, subject, html, attachment, senderName, opts);
  if (b.status === 'accepted') return { ...strip(b), ref: `brevo:${b.ref || ''}` };
  if (b.status === 'disabled') return strip(r);
  // Sem resposta da reserva: pode ter saído. "ambiguous" faz a fila não repetir sozinha (evita duplicar).
  if (b.ambiguous) return { status: 'failed', error: `ambiguous: reserva Brevo sem resposta (${b.error}); principal: ${r.error}` };
  return { status: 'failed', error: `${r.error}; reserva: ${b.error}`, permanent: !!b.permanent && !!r.permanent };
}
type ProviderResult = SendResult & { ambiguous?: boolean };
const strip = ({ ambiguous, ...r }: ProviderResult): SendResult => r;

async function sendResend(to: string, subject: string, html: string, attachment?: Attachment, senderName?: string | null,
  opts: { text?: string; idempotencyKey?: string } = {}): Promise<ProviderResult> {
  const key = optionalEnv('RESEND_API_KEY');
  const base = optionalEnv('RESEND_FROM_EMAIL');
  if (!key || !base) return { status: 'disabled', error: 'Resend não configurado' };
  const from = fromHeader(base, senderName);
  let r: Response;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      // Idempotency-Key: o mesmo job reenviado (retry após timeout) não vira e-mail duplicado no Resend.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}) },
      body: JSON.stringify({ from, to: [to], subject, html, ...(opts.text ? { text: opts.text } : {}),
        ...(attachment ? { attachments: [{ filename: attachment.filename, content: Buffer.from(attachment.content).toString('base64') }] } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    return { status: 'failed', error: e?.message || 'rede', ambiguous: true };
  }
  const d: any = await r.json().catch(() => ({}));
  if (r.ok) return { status: 'accepted', ref: d.id };
  // 422 = endereço/campos recusados: não adianta repetir nem trocar de provedor.
  const reason = d?.name ? ` ${String(d.name).slice(0, 40)}` : '';
  return { status: 'failed', error: `Resend HTTP ${r.status}${reason}`, permanent: r.status === 422 };
}

async function sendBrevo(to: string, subject: string, html: string, attachment?: Attachment, senderName?: string | null,
  opts: { text?: string } = {}): Promise<ProviderResult> {
  const key = optionalEnv('BREVO_API_KEY');
  const base = optionalEnv('BREVO_FROM_EMAIL') || optionalEnv('RESEND_FROM_EMAIL');
  if (!key || !base) return { status: 'disabled', error: 'Brevo não configurado' };
  const email = base.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || base.trim();
  const name = String(senderName || '').replace(/["<>\\\r\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json', 'api-key': key },
      body: JSON.stringify({ sender: { email, name: name ? `${name} via Portaria Prime` : 'Portaria Prime' }, to: [{ email: to }], subject, htmlContent: html,
        ...(opts.text ? { textContent: opts.text } : {}),
        ...(attachment ? { attachment: [{ name: attachment.filename, content: Buffer.from(attachment.content).toString('base64') }] } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    const d: any = await r.json().catch(() => ({}));
    return r.ok ? { status: 'accepted', ref: d.messageId } : { status: 'failed', error: `Brevo HTTP ${r.status}${d?.code ? ` ${String(d.code).slice(0, 40)}` : ''}`, permanent: r.status === 400 };
  } catch (e: any) {
    return { status: 'failed', error: e?.message || 'rede', ambiguous: true };
  }
}

/** Evolution API: URL fixa do servidor (env), nunca informada pelo cliente (sem SSRF). */
export async function sendWhatsApp(instance: string, phone: string, text: string): Promise<SendResult> {
  const base = optionalEnv('EVOLUTION_API_URL');
  const key = optionalEnv('EVOLUTION_API_KEY');
  if (!base || !key) return { status: 'disabled', error: 'Evolution não configurada' };
  const digits = phone.replace(/\D/g, '');
  const number = digits.startsWith('55') ? digits : `55${digits}`;
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ number, text, options: { delay: 800, linkPreview: false } }),
      signal: AbortSignal.timeout(15000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (r.ok) return { status: 'accepted', ref: d?.key?.id };
    // 400 = número sem WhatsApp/formato; 401/403 = chave; 404 = instância. Sem dados do corpo (pode conter o número).
    const why = r.status === 400 ? 'número inválido ou sem WhatsApp' : r.status === 401 || r.status === 403 ? 'credencial recusada'
      : r.status === 404 ? 'instância não encontrada' : 'erro do provedor';
    return { status: 'failed', error: `Evolution HTTP ${r.status}: ${why}`, permanent: r.status === 400 };
  } catch (e: any) {
    // Tempo esgotado: a Evolution pode ter enviado. Não repete sozinho para não duplicar.
    if (e?.name === 'TimeoutError') return { status: 'failed', error: 'ambiguous: tempo esgotado após envio à Evolution' };
    return { status: 'failed', error: `rede: ${e?.message || 'indisponível'}` };
  }
}

/** Documento (PDF) em base64 — Evolution v2: POST /message/sendMedia/{instance}. */
export async function sendWhatsAppDocument(instance: string, phone: string, caption: string, doc: Attachment): Promise<SendResult> {
  const base = optionalEnv('EVOLUTION_API_URL');
  const key = optionalEnv('EVOLUTION_API_KEY');
  if (!base || !key) return { status: 'disabled', error: 'Evolution não configurada' };
  const digits = phone.replace(/\D/g, '');
  const number = digits.startsWith('55') ? digits : `55${digits}`;
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/message/sendMedia/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ number, mediatype: 'document', mimetype: 'application/pdf', fileName: doc.filename, caption,
        media: Buffer.from(doc.content).toString('base64') }),
      signal: AbortSignal.timeout(30000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (r.ok) return { status: 'accepted', ref: d?.key?.id };
    const why = r.status === 400 ? 'número inválido ou documento recusado' : r.status === 401 || r.status === 403 ? 'credencial recusada'
      : r.status === 404 ? 'instância não encontrada' : r.status === 413 ? 'arquivo grande demais' : 'erro do provedor';
    return { status: 'failed', error: `Evolution HTTP ${r.status}: ${why}`, permanent: r.status === 400 || r.status === 413 };
  } catch (e: any) {
    if (e?.name === 'TimeoutError') return { status: 'failed', error: 'ambiguous: tempo esgotado após envio à Evolution' };
    return { status: 'failed', error: `rede: ${e?.message || 'indisponível'}` };
  }
}

/** Estado da instância (somente leitura). */
export async function whatsAppState(instance: string): Promise<'open' | 'closed' | 'unknown'> {
  const base = optionalEnv('EVOLUTION_API_URL');
  const key = optionalEnv('EVOLUTION_API_KEY');
  if (!base || !key) return 'unknown';
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/instance/connectionState/${encodeURIComponent(instance)}`,
      { headers: { apikey: key }, signal: AbortSignal.timeout(10000) });
    const d: any = await r.json().catch(() => ({}));
    return (d?.instance?.state || d?.state) === 'open' ? 'open' : r.ok || r.status === 404 ? 'closed' : 'unknown';
  } catch { return 'unknown'; }
}

export function vapidConfigured(): boolean {
  const pub = optionalEnv('VITE_VAPID_PUBLIC_KEY');
  const priv = optionalEnv('VAPID_PRIVATE_KEY');
  const subj = optionalEnv('VAPID_SUBJECT');
  if (!pub || !priv || !subj) return false;
  webpush.setVapidDetails(subj, pub, priv);
  return true;
}

/** Lista fechada: rejeita destinos internos e hosts controlados pelo assinante. */
export function validPushEndpoint(endpoint: string): boolean {
  return /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\/[^\s#]*$/.test(endpoint);
}

export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: object): Promise<SendResult> {
  if (!validPushEndpoint(sub.endpoint)) return { status: 'disabled', error: 'Destino push não autorizado', gone: true };
  if (!vapidConfigured()) return { status: 'disabled', error: 'VAPID não configurado' };
  try {
    const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload), { TTL: 60 * 60 * 24 });
    return { status: 'accepted', ref: String(r.statusCode) };
  } catch (e: any) {
    const gone = e?.statusCode === 404 || e?.statusCode === 410;
    return { status: 'failed', error: `Push HTTP ${e?.statusCode || '?'}`, gone };
  }
}
