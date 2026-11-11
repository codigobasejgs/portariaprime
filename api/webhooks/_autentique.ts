/**
 * POST /api/webhooks/autentique (vercel.json → função de webhooks; limite de 12 funções).
 *   1. corpo bruto limitado; HMAC x-autentique-signature com AUTENTIQUE_WEBHOOK_SECRET quando configurado;
 *   2. evento gravado por id ANTES de processar (reenvio = duplicado, sem nova ação);
 *   3. estado aplicado só depois de consultar o documento na API da Autentique (double-check).
 * Webhook forjado não muda nada: sem assinatura real na Autentique, a consulta não mostra assinatura.
 */
import { json } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { verifyWebhookSignature } from '../_lib/autentique.js';
import { syncSignature } from '../_lib/contract-sign.js';

const RELEVANT = /^(signature\.(accepted|rejected|updated)|document\.(finished|updated))$/;

/** Extrai id do evento, tipo e id do documento (formato atual e o "deprecated"). */
export function parseAutentiqueEvent(body: any): { eventId: string; type: string; documentId: string | null } | null {
  const ev = body?.event;
  if (!ev || typeof ev !== 'object') return null;
  const type = typeof ev.type === 'string' ? ev.type : '';
  const eventId = typeof ev.id === 'string' ? ev.id : '';
  if (!/^[a-z_]+\.[a-z_]+$/.test(type) || !/^[0-9A-Za-z=_-]{8,200}$/.test(eventId)) return null;
  const o = ev.data?.object && typeof ev.data.object === 'object' ? ev.data.object : ev.data;
  const doc = type.startsWith('document.') ? (o?.id ?? ev.data?.id) : (o?.document ?? ev.data?.document);
  const documentId = typeof doc === 'string' && /^[0-9A-Za-z_-]{8,120}$/.test(doc) ? doc : null;
  return { eventId, type, documentId };
}

export async function autentiqueWebhook(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > 512 * 1024) return json({ ok: false }, 413);
  const secret = optionalEnv('AUTENTIQUE_WEBHOOK_SECRET');
  const sigOk = verifyWebhookSignature(raw, request.headers.get('x-autentique-signature'), secret);
  // Com segredo configurado, assinatura inválida é recusada; sem segredo, vale só o double-check na API.
  if (secret && !sigOk) return json({ ok: false }, 401);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ ok: false }, 400); }
  const evt = parseAutentiqueEvent(body);
  if (!evt) return json({ ok: false }, 400);

  const svc = serviceClient();
  const { data: ins, error } = await svc.from('autentique_webhook_events')
    .upsert({ event_id: evt.eventId, event_type: evt.type, document_id: evt.documentId, signature_valid: secret ? sigOk : null },
      { onConflict: 'event_id', ignoreDuplicates: true }).select('event_id');
  if (error) { console.error('[autentique.webhook] gravar', error.message); return json({ ok: false }, 500); }
  if (!ins?.length) return json({ ok: true, duplicate: true });

  const finish = (status: string, err?: string) => svc.from('autentique_webhook_events')
    .update({ status, error: err ? err.slice(0, 500) : null, processed_at: new Date().toISOString() }).eq('event_id', evt.eventId);
  if (!RELEVANT.test(evt.type) || !evt.documentId) { await finish('ignored'); return json({ ok: true }); }
  const { data: acceptance } = await svc.rpc('contract_signature_by_document', { p_document_id: evt.documentId });
  if (!acceptance) { await finish('ignored', 'documento não pertence a um contrato'); return json({ ok: true }); }
  try {
    await Promise.race([syncSignature(svc, acceptance), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
    await finish('processed');
  } catch (e: any) {
    // O "Atualizar status" e novos eventos refazem a consulta; o evento fica registrado com o erro.
    await finish('error', String(e?.message || e));
  }
  return json({ ok: true });
}
