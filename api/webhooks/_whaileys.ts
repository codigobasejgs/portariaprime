/**
 * POST /api/webhooks/whaileys (vercel.json → função de webhooks; limite de 12 funções da Vercel Hobby).
 *   1. corpo bruto limitado + HMAC x-whaileys-signature (janela de 5 min, tempo constante) → senão 401;
 *   2. instância conferida (só a do Portaria Prime);
 *   3. remetente com número real; desconhecido recebe recusa genérica (não revela condomínio nem dados);
 *   4. id da mensagem gravado ANTES de processar (entrega "pelo menos uma vez": repetida = sem efeito);
 *   5. responde e envia a resposta pelo motor. Mutação só depois de ✅ (assistant_confirm).
 */
import { json } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { parseIncoming, sender, verifyWhaileysSignature, whaileysEnabled, whaileysKnownPhones, whaileysSend, type IncomingKey } from '../_lib/whaileys.js';
import { mainMenu, respond, type Link } from '../_lib/assistant.js';
import { numberedCard } from '../_lib/whaileys.js';

interface Payload { instanceKey?: string; key?: IncomingKey; message?: unknown; media?: { mimetype?: string; data?: string } }

export async function whaileysWebhook(request: Request): Promise<Response> {
  if (!whaileysEnabled()) return json({ error: 'disabled' }, 503);
  const raw = await request.text();
  if (raw.length > 12_000_000) return json({ error: 'payload' }, 413);
  if (!verifyWhaileysSignature(raw, request.headers.get('x-whaileys-timestamp'), request.headers.get('x-whaileys-signature'))) return json({ error: 'unauthorized' }, 401);
  let body: Payload;
  try { body = JSON.parse(raw); } catch { return json({ error: 'payload' }, 400); }
  if (body.instanceKey !== optionalEnv('WHAILEYS_INSTANCE')) return json({ ignored: true });
  const msgId = body.key?.id;
  if (typeof msgId !== 'string' || !/^[A-Za-z0-9._-]{4,128}$/.test(msgId)) return json({ ignored: true });

  const who = sender(body.key!);
  const svc = serviceClient();
  if ('ignore' in who) {
    // Só LID: o motor ainda não conhece os números autorizados (reinício). Reenvia a lista; a próxima mensagem chega com o número.
    if (who.lidOnly) {
      const { data } = await svc.from('assistant_links').select('phone').eq('active', true).limit(50);
      if (data?.length) await whaileysKnownPhones(data.map((r) => r.phone)).catch(() => {});
    }
    return json({ ignored: true });
  }

  // Dedupe por id do provedor (unique). Repetida não processa de novo.
  const { error: dup } = await svc.from('assistant_messages').insert({ provider_id: msgId, phone: who.phone });
  if (dup) return json({ duplicate: true });

  const send = (card: Parameters<typeof whaileysSend>[1]) => whaileysSend(who.replyTo, card).catch((e) => console.error('[assistant] envio', (e as Error).message));
  const { data: links } = await svc.rpc('assistant_resolve', { p_phone: who.phone });
  const list = (links || []) as Link[];
  if (!list.length) {
    await send({ text: 'Portaria Prime IA: este número não está autorizado. Peça ao síndico para cadastrá-lo em Configurações › Assistente no WhatsApp.' });
    return json({ ok: true, unauthorized: true });
  }

  const { data: session } = await svc.from('assistant_sessions').select('tenant_id, options').eq('phone', who.phone).maybeSingle();
  const options: string[] = Array.isArray(session?.options) ? session!.options : [];
  const ev = parseIncoming(body.message, options);
  if (ev.kind === 'ignored') return json({ ignored: true });

  // Vários condomínios no mesmo número: escolha explícita (tenant:<id>), lembrada na sessão.
  let link = list.length === 1 ? list[0] : list.find((l) => l.tenant_id === session?.tenant_id) || null;
  if (ev.kind === 'action' && ev.id.startsWith('tenant:')) {
    link = list.find((l) => l.tenant_id === ev.id.slice(7)) || null;
    if (link) {
      const reply = mainMenu(link, `Condomínio selecionado: ${link.tenant_name}.`);
      await save(svc, who.phone, link.tenant_id, reply.options);
      await send(reply.card);
      return json({ ok: true });
    }
  }
  if (!link) {
    const { card, ids } = numberedCard('Você tem acesso a mais de um condomínio. Qual deles?', list.map((l) => ({ id: `tenant:${l.tenant_id}`, title: l.tenant_name.slice(0, 24) })), true);
    await save(svc, who.phone, null, ids);
    await send(card);
    return json({ ok: true });
  }

  // Limites: mensagens por telefone e orçamento de IA por condomínio (texto livre e áudio vão para a IA).
  const usesAi = ev.kind === 'audio' || (ev.kind === 'text' && !/^(\/?menu|oi|ol[aá]|in[ií]cio|ajuda|0)$/i.test(ev.text.trim()));
  const { data: rate } = await svc.rpc('assistant_rate', { p_link: link.link_id, p_phone: who.phone, p_ai: usesAi });
  if (rate && rate.ok === false) {
    if (rate.reason === 'tenant') await send({ text: 'O limite diário de pedidos por texto e áudio deste condomínio foi atingido. Use os botões do menu (envie "menu") até amanhã.' });
    else if (rate.reason === 'phone') await send({ text: 'Muitas mensagens seguidas. Aguarde alguns minutos e tente de novo.' });
    return json({ ok: true, limited: rate.reason });
  }

  const media = body.media?.data && body.media.mimetype ? { mimetype: body.media.mimetype, data: body.media.data } : undefined;
  try {
    const reply = await respond(svc, link, ev, media);
    // Opções de troca de condomínio continuam valendo quando há mais de um.
    const extra = list.length > 1 ? list.filter((l) => l.tenant_id !== link!.tenant_id).map((l) => `tenant:${l.tenant_id}`) : [];
    // Envia ANTES de gravar as opções: se o card não chegou, a resposta seguinte não pode valer para ele.
    const delivered = await whaileysSend(who.replyTo, reply.card).then(() => true, (e) => { console.error('[assistant] envio', (e as Error).message); return false; });
    if (delivered) await save(svc, who.phone, link.tenant_id, [...reply.options, ...extra]);
  } catch (e) {
    console.error('[assistant]', (e as Error).message);
    await send({ text: 'Não consegui concluir agora. Tente de novo em instantes ou use o painel. Nada foi alterado.' });
  }
  return json({ ok: true });
}

async function save(svc: ReturnType<typeof serviceClient>, phone: string, tenantId: string | null, options: string[]) {
  await svc.from('assistant_sessions').upsert({ phone, tenant_id: tenantId, options: options.slice(0, 20), updated_at: new Date().toISOString() });
}
