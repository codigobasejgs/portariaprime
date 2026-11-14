/**
 * Motor Whaileys (WhatsApp com botões e listas). Credenciais só no servidor (Vercel). Independente da Evolution.
 *  - Número da plataforma (opcional): WHAILEYS_INSTANCE, WHAILEYS_TOKEN, WHAILEYS_WEBHOOK_SECRET.
 *  - Número de cada condomínio: instância ppia-<condomínio> criada com WHAILEYS_PARTNER_KEY (o motor só deixa essa
 *    chave mexer em instâncias ppia-*); token e segredo de cada uma ficam em assistant_channels (só service_role).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, optionalEnv } from './env.js';
import type { Card } from './whatsapp-card.js';
export * from './whatsapp-card.js';

/** Instância no motor e o token que opera só ela. */
export interface Channel { instance: string; token: string }
export interface SessionStatus { state: string; qr: string | null; pairingCode?: string | null; me: { id: string | null } | null }

export const whaileysEnabled = () => !!(optionalEnv('WHAILEYS_API_URL') && optionalEnv('WHAILEYS_INSTANCE') && optionalEnv('WHAILEYS_TOKEN') && optionalEnv('WHAILEYS_WEBHOOK_SECRET'));
/** Conexão do WhatsApp da IA pelo painel de cada condomínio. */
export const partnerEnabled = () => !!(optionalEnv('WHAILEYS_API_URL') && optionalEnv('WHAILEYS_PARTNER_KEY'));
export const channelName = (tenantId: string) => `ppia-${tenantId.toLowerCase()}`;
export const CHANNEL_RE = /^ppia-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class WhaileysError extends Error { constructor(message: string, public status: number) { super(message); } }

async function request<T>(path: string, key: string, init: RequestInit = {}): Promise<T> {
  const base = (optionalEnv('WHAILEYS_API_URL') || '').replace(/\/+$/, '');
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'x-api-key': key, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new WhaileysError(d?.error ? `WhatsApp: ${String(d.error).slice(0, 120)}` : `WhatsApp indisponível (HTTP ${r.status}).`, r.status);
  return d as T;
}

const platform = (): Channel => ({ instance: optionalEnv('WHAILEYS_INSTANCE') || '', token: optionalEnv('WHAILEYS_TOKEN') || '' });
const call = <T>(path: string, init: RequestInit = {}, ch: Channel = platform()) =>
  request<T>(`/sessions/${encodeURIComponent(ch.instance)}${path}`, ch.token, init);

export const whaileysStatus = (ch?: Channel) => call<SessionStatus>('', {}, ch);
/** Com telefone (55 + DDD + número), o motor devolve também o código de pareamento de 8 dígitos. */
export const whaileysConnect = (ch?: Channel, phone?: string) => call<SessionStatus>('/connect', { method: 'POST', body: JSON.stringify(phone ? { phone } : {}) }, ch);
export const whaileysLogout = (ch: Channel) => call<{ ok: boolean }>('', { method: 'DELETE' }, ch);
export const whaileysSend = (to: string, card: Card, ch?: Channel) => call<{ messageId: string }>('/send', { method: 'POST', body: JSON.stringify({ to, ...card }) }, ch);
/** Números autorizados: o motor usa para descobrir o número de quem escreve só com LID (privacidade do WhatsApp). */
export const whaileysKnownPhones = (phones: string[], ch?: Channel) => call('/known-phones', { method: 'POST', body: JSON.stringify({ phones: phones.slice(0, 50) }) }, ch);

/**
 * Cria a instância do condomínio no motor (chave de parceiro). Já existente sem registro aqui (ex.: falha entre criar e
 * gravar): troca token e segredo, porque os antigos não aparecem de novo. Devolve as credenciais novas.
 */
export async function ensureInstance(name: string, webhookUrl: string): Promise<{ token: string; webhookSecret: string }> {
  const key = env('WHAILEYS_PARTNER_KEY');
  try {
    return await request('/instances', key, { method: 'POST', body: JSON.stringify({ name, webhookUrl }) });
  } catch (e) {
    if (!(e instanceof WhaileysError) || e.status !== 409) throw e;
    return request(`/instances/${encodeURIComponent(name)}`, key, { method: 'PATCH', body: JSON.stringify({ webhookUrl, rotateToken: true, rotateSecret: true }) });
  }
}

/** HMAC-SHA256 de `${timestamp}.${corpo}` com o segredo da instância; janela de 5 minutos, tempo constante. */
export function verifyWhaileysSignature(raw: string, timestamp: string | null, signature: string | null,
  secret = optionalEnv('WHAILEYS_WEBHOOK_SECRET') || '', now = Date.now()): boolean {
  if (!secret || !timestamp || !signature || !/^\d{13}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp)) > 300_000) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

// ------------------------------------------------------------------------- remetente
export interface IncomingKey { remoteJid?: string | null; fromMe?: boolean | null; id?: string | null; senderPn?: string | null; remoteJidAlt?: string | null }

/** "5511999999999:12@s.whatsapp.net" → "5511999999999". */
export const jidUser = (jid?: string | null) => (jid ?? '').split('@')[0].split(':')[0];
const isPn = (jid?: string | null) => /@s\.whatsapp\.net$/.test(jid ?? '');

/**
 * Quem escreveu, com número real. Mensagens do próprio número (fromMe), grupos e status são ignoradas:
 * o assistente só responde a quem escreve PARA o número da plataforma. Só LID, sem número = ignorado (lidOnly).
 */
export function sender(key: IncomingKey): { phone: string; replyTo: string } | { ignore: string; lidOnly?: boolean } {
  const remote = key.remoteJid ?? '';
  if (!remote || /@(g\.us|broadcast|newsletter)$/.test(remote)) return { ignore: 'chat' };
  if (key.fromMe) return { ignore: 'fromMe' };
  const pn = isPn(remote) ? remote : isPn(key.senderPn) ? key.senderPn : isPn(key.remoteJidAlt) ? key.remoteJidAlt : null;
  const phone = jidUser(pn).replace(/\D/g, '');
  if (!/^\d{12,13}$/.test(phone)) return { ignore: 'sem número', lidOnly: /@lid$/.test(remote) };
  return { phone, replyTo: remote };
}
