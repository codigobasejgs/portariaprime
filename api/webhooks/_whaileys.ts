/**
 * POST /api/webhooks/whaileys (vercel.json → função de webhooks; limite de 12 funções da Vercel Hobby).
 *   1. corpo bruto limitado + HMAC x-whaileys-signature com o segredo DA INSTÂNCIA (janela de 5 min, tempo constante) → senão 401;
 *      instâncias aceitas: a da plataforma (WHAILEYS_INSTANCE) e as ppia-<condomínio> conectadas no painel do síndico;
 *   2. remetente com número real; no número da plataforma, desconhecido recebe recusa genérica (não revela nada);
 *      no número do condomínio, só os autorizados DAQUELE condomínio são atendidos e o resto fica em silêncio
 *      (o chip pode ser o mesmo da Evolution: moradores respondendo avisos não falam com a IA);
 *   3. id da mensagem gravado ANTES de processar (entrega "pelo menos uma vez": repetida = sem efeito);
 *   4. responde e envia a resposta pela mesma instância. Mutação só depois de ✅ (assistant_confirm).
 */
import { json } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';
import { optionalEnv } from '../_lib/env.js';
import { CHANNEL_RE, parseIncoming, sender, verifyWhaileysSignature, whaileysEnabled, whaileysKnownPhones, whaileysSend, type Channel, type IncomingKey } from '../_lib/whaileys.js';
import { mainMenu, respond, type Link } from '../_lib/assistant.js';
import { numberedCard } from '../_lib/whaileys.js';

interface Payload { instanceKey?: string; key?: IncomingKey; message?: unknown; media?: { mimetype?: string; data?: string } }
type Svc = ReturnType<typeof serviceClient>;
/** Instância que recebeu a mensagem: credenciais para responder e, se for de um condomínio, qual. */
interface Inbox { ch: Channel; secret: string; tenantId: string | null }

async function inbox(svc: () => Svc, instance: unknown): Promise<Inbox | null> {
  if (typeof instance !== 'string') return null;
  if (whaileysEnabled() && instance === optionalEnv('WHAILEYS_INSTANCE')) {
    return { ch: { instance, token: optionalEnv('WHAILEYS_TOKEN')! }, secret: optionalEnv('WHAILEYS_WEBHOOK_SECRET')!, tenantId: null };
  }
  if (!CHANNEL_RE.test(instance)) return null;
  const { data } = await svc().from('assistant_channels').select('tenant_id, token, webhook_secret').eq('instance', instance).maybeSingle();
  return data ? { ch: { instance, token: data.token }, secret: data.webhook_secret, tenantId: data.tenant_id } : null;
}

export async function whaileysWebhook(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > 12_000_000) return json({ error: 'payload' }, 413);
  let body: Payload;
  try { body = JSON.parse(raw); } catch { return json({ error: 'payload' }, 400); }
  let client: Svc | null = null;
  const svcOf = () => (client ??= serviceClient());
  // O segredo depende da instância; nada do corpo é usado antes da assinatura conferir.
  const box = await inbox(svcOf, body?.instanceKey);
  if (!box) return json({ ignored: true });
  if (!verifyWhaileysSignature(raw, request.headers.get('x-whaileys-timestamp'), request.headers.get('x-whaileys-signature'), box.secret)) return json({ error: 'unauthorized' }, 401);
  const msgId = body.key?.id;
  if (typeof msgId !== 'string' || !/^[A-Za-z0-9._-]{4,128}$/.test(msgId)) return json({ ignored: true });

  const who = sender(body.key!);
  const svc = svcOf();
  if ('ignore' in who) {
    // Só LID: o motor ainda não conhece os números autorizados (reinício). Reenvia a lista; a próxima mensagem chega com o número.
    if (who.lidOnly) {
      let q = svc.from('assistant_links').select('phone').eq('active', true);
      if (box.tenantId) q = q.eq('tenant_id', box.tenantId);
      const { data } = await q.limit(50);
      if (data?.length) await whaileysKnownPhones(data.map((r) => r.phone), box.ch).catch(() => {});
    }
    return json({ ignored: true });
  }

  const { data: links } = await svc.rpc('assistant_resolve', { p_phone: who.phone });
  // Número do condomínio: só os vínculos dele (o mesmo telefone pode estar autorizado em outro condomínio).
  const list = ((links || []) as Link[]).filter((l) => !box.tenantId || l.tenant_id === box.tenantId);
  // Desconhecido no número do condomínio: silêncio, sem gravar o telefone de quem só respondeu um aviso.
  if (!list.length && box.tenantId) return json({ ignored: true });

  // Dedupe por id do provedor (unique). Repetida não processa de novo.
  const { error: dup } = await svc.from('assistant_messages').insert({ provider_id: msgId, phone: who.phone });
  if (dup) return json({ duplicate: true });

  const send = (card: Parameters<typeof whaileysSend>[1]) => whaileysSend(who.replyTo, card, box.ch).catch((e) => console.error('[assistant] envio', (e as Error).message));
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
    const delivered = await whaileysSend(who.replyTo, reply.card, box.ch).then(() => true, (e) => { console.error('[assistant] envio', (e as Error).message); return false; });
    if (delivered) await save(svc, who.phone, link.tenant_id, [...reply.options, ...extra]);
  } catch (e) {
    console.error('[assistant]', (e as Error).message);
    await send({ text: 'Não consegui concluir agora. Tente de novo em instantes ou use o painel. Nada foi alterado.' });
  }
  return json({ ok: true });
}

async function save(svc: Svc, phone: string, tenantId: string | null, options: string[]) {
  await svc.from('assistant_sessions').upsert({ phone, tenant_id: tenantId, options: options.slice(0, 20), updated_at: new Date().toISOString() });
}
