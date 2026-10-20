/**
 * Envio real por canal. Cada função devolve o status honesto:
 *   accepted = provedor aceitou (não é confirmação de entrega)
 *   failed   = erro (com retry pela fila)
 *   disabled = canal não configurado/indisponível (nunca vira "sucesso")
 */
import webpush from 'web-push';
import { optionalEnv } from './env.js';

export type SendResult = { status: 'accepted' | 'failed' | 'disabled'; ref?: string; error?: string; gone?: boolean };

export async function sendEmail(to: string, subject: string, html: string): Promise<SendResult> {
  const key = optionalEnv('RESEND_API_KEY');
  const from = optionalEnv('RESEND_FROM_EMAIL');
  if (!key || !from) return { status: 'disabled', error: 'Resend não configurado' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(15000),
    });
    const d: any = await r.json().catch(() => ({}));
    return r.ok ? { status: 'accepted', ref: d.id } : { status: 'failed', error: `Resend HTTP ${r.status}` };
  } catch (e: any) {
    return { status: 'failed', error: e?.message || 'rede' };
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
    return r.ok ? { status: 'accepted', ref: d?.key?.id } : { status: 'failed', error: `Evolution HTTP ${r.status}` };
  } catch (e: any) {
    return { status: 'failed', error: e?.message || 'rede' };
  }
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
