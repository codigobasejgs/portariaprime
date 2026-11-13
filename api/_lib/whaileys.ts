/**
 * Motor Whaileys (WhatsApp com botões e listas). Credenciais só no servidor (Vercel):
 * WHAILEYS_API_URL, WHAILEYS_INSTANCE, WHAILEYS_TOKEN, WHAILEYS_WEBHOOK_SECRET. Independente da Evolution.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { optionalEnv } from './env.js';
import type { Card } from './whatsapp-card.js';
export * from './whatsapp-card.js';

export const whaileysEnabled = () => !!(optionalEnv('WHAILEYS_API_URL') && optionalEnv('WHAILEYS_INSTANCE') && optionalEnv('WHAILEYS_TOKEN') && optionalEnv('WHAILEYS_WEBHOOK_SECRET'));

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = (optionalEnv('WHAILEYS_API_URL') || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/sessions/${encodeURIComponent(optionalEnv('WHAILEYS_INSTANCE') || '')}${path}`, {
    ...init,
    headers: { 'x-api-key': optionalEnv('WHAILEYS_TOKEN') || '', 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error ? `WhatsApp: ${String(d.error).slice(0, 120)}` : `WhatsApp indisponível (HTTP ${r.status}).`);
  return d as T;
}

export const whaileysStatus = () => call<{ state: string; qr: string | null; me: { id: string | null } | null }>('');
export const whaileysConnect = () => call<{ state: string; qr: string | null }>('/connect', { method: 'POST', body: '{}' });
export const whaileysSend = (to: string, card: Card) => call<{ messageId: string }>('/send', { method: 'POST', body: JSON.stringify({ to, ...card }) });
/** Números autorizados: o motor usa para descobrir o número de quem escreve só com LID (privacidade do WhatsApp). */
export const whaileysKnownPhones = (phones: string[]) => call('/known-phones', { method: 'POST', body: JSON.stringify({ phones: phones.slice(0, 50) }) });

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

