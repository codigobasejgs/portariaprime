/**
 * WhatsApp do Portaria Prime IA de cada condomínio (motor Whaileys), operado pelo painel do síndico:
 *   POST /api/whatsapp/ia-status   { tenantId }          -> { state, qr, pairingCode, phone }
 *   POST /api/whatsapp/ia-connect  { tenantId, phone? }  -> cria a instância ppia-<condomínio> se preciso e devolve QR
 *                                                            (com phone, também o código de pareamento de 8 dígitos)
 *   POST /api/whatsapp/ia-logout   { tenantId }          -> desconecta o número
 * Permissão conferida no banco como o usuário (assistant_channel_gate). Token e segredo nunca saem do servidor.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { appUrl } from './env.js';
import { HttpError, json } from './http.js';
import { rpcError, serviceClient } from './supabase.js';
import { channelName, ensureInstance, jidUser, partnerEnabled, whaileysConnect, whaileysKnownPhones, whaileysLogout, whaileysStatus,
  WhaileysError, type Channel, type SessionStatus } from './whaileys.js';

const OPS = ['status', 'connect', 'logout'];

/** Motor sem a instância (apagada lá): conta como desconectado. */
const missing = (e: unknown) => e instanceof WhaileysError && e.status === 404;
const view = (s: SessionStatus) => ({ state: s.state, qr: s.qr || null, pairingCode: s.pairingCode || null, phone: jidUser(s.me?.id) || null });

export async function assistantChannel(client: SupabaseClient, tenantId: string, op: string, rawPhone?: unknown): Promise<Response> {
  if (!OPS.includes(op)) throw new HttpError(404, 'Ação desconhecida.');
  const { error } = await client.rpc('assistant_channel_gate', { p_tenant: tenantId, p_action: op });
  if (error) rpcError(error);
  if (!partnerEnabled()) throw new HttpError(503, 'O WhatsApp do assistente ainda não está disponível na plataforma.');

  const svc = serviceClient();
  const { data: row } = await svc.from('assistant_channels').select('instance, token, phone').eq('tenant_id', tenantId).maybeSingle();
  let ch: Channel | null = row ? { instance: row.instance, token: row.token } : null;
  const off = { state: 'disconnected', qr: null, pairingCode: null, phone: null };

  if (op === 'status') {
    if (!ch) return json(off);
    const s = await whaileysStatus(ch).catch((e) => { if (missing(e)) return null; throw e; });
    if (!s) return json(off);
    const v = view(s);
    if (v.state === 'open') {
      if (v.phone && v.phone !== row!.phone) {
        await svc.from('assistant_channels').update({ phone: v.phone, connected_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('tenant_id', tenantId);
      }
      // Números autorizados do condomínio: o motor resolve quem escreve só com LID (privacidade do WhatsApp).
      const { data: links } = await svc.from('assistant_links').select('phone').eq('tenant_id', tenantId).eq('active', true).limit(50);
      if (links?.length) await whaileysKnownPhones(links.map((l) => l.phone), ch).catch(() => {});
    }
    return json(v);
  }

  if (op === 'logout') {
    if (ch) await whaileysLogout(ch).catch((e) => { if (!missing(e)) throw e; });
    await svc.from('assistant_channels').update({ phone: null, connected_at: null, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId);
    return json(off);
  }

  // connect
  let phone: string | undefined;
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== '') {
    const d = String(rawPhone).replace(/\D/g, '');
    phone = /^\d{10,11}$/.test(d) ? `55${d}` : d;
    if (!/^55\d{10,11}$/.test(phone)) throw new HttpError(400, 'Informe o WhatsApp com DDD (ex.: 11 99999-0000).');
  }
  if (!ch) {
    const instance = channelName(tenantId);
    const created = await ensureInstance(instance, `${appUrl()}/api/webhooks/whaileys`);
    const { data: { user } } = await client.auth.getUser();
    const { error: se } = await svc.from('assistant_channels').upsert({ tenant_id: tenantId, instance, token: created.token, webhook_secret: created.webhookSecret,
      phone: null, connected_at: null, created_by: user?.id ?? null, updated_at: new Date().toISOString() });
    if (se) throw new Error(`assistant_channels: ${se.message}`);
    ch = { instance, token: created.token };
  }
  const s = await whaileysConnect(ch, phone).catch(async (e) => {
    if (!missing(e)) throw e;
    // Instância apagada no motor: recria com credenciais novas e tenta uma vez.
    const created = await ensureInstance(ch!.instance, `${appUrl()}/api/webhooks/whaileys`);
    await svc.from('assistant_channels').update({ token: created.token, webhook_secret: created.webhookSecret, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId);
    return whaileysConnect({ instance: ch!.instance, token: created.token }, phone);
  });
  return json(view(s));
}
