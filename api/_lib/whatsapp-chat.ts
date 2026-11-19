/**
 * Conversas do WhatsApp dos avisos (Evolution) no painel do síndico. As mensagens ficam só na Evolution.
 *   POST /api/whatsapp/chat-list     { tenantId }                          -> conversas (mais recentes primeiro)
 *   POST /api/whatsapp/chat-messages { tenantId, jid, page? }              -> mensagens da conversa (mais recentes primeiro)
 *   POST /api/whatsapp/chat-send     { tenantId, jid, text?, file? }       -> texto ou anexo (file = caminho em tenant-chat/<tenant>/out/)
 *   POST /api/whatsapp/chat-media    { tenantId, id }                      -> URL assinada curta da mídia recebida/enviada
 * Permissão conferida no banco como o usuário (whatsapp_chat_gate). Só responde conversas que já existem na instância
 * do condomínio: o painel não vira disparador para números quaisquer. Os avisos automáticos seguem como estão.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { HttpError, json } from './http.js';
import { rpcError, serviceClient } from './supabase.js';

const OPS = ['list', 'messages', 'send', 'media'];
const JID = /^[\w.-]{5,40}@(s\.whatsapp\.net|lid)$/;
const BUCKET = 'tenant-chat';
const MEDIA: Record<string, 'image' | 'video' | 'document'> = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/3gpp': 'video', 'application/pdf': 'document' };
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/pdf': 'pdf' };

export const instanceOf = (tenantId: string) => `pp-${tenantId.slice(0, 8)}-${tenantId.slice(-4)}`;

async function evo(path: string, body: unknown, timeout = 20000): Promise<any> {
  const r = await fetch(`${env('EVOLUTION_API_URL').replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env('EVOLUTION_API_KEY') },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  // Mídia recebida pode ser enorme (qualquer pessoa manda até 2 GB): recusa antes de ler o corpo.
  // 20 MB em base64 viram ~27 MB de JSON.
  if (Number(r.headers.get('content-length')) > 28 * 1024 * 1024) { await r.body?.cancel(); throw new HttpError(413, 'Arquivo grande demais para abrir no painel (máximo 20 MB). Abra no celular do condomínio.'); }
  const d: any = await r.json().catch(() => ({}));
  if (r.status === 404) throw new HttpError(409, 'WhatsApp do condomínio não encontrado. Conecte em Configurações › Integrações.');
  if (!r.ok) throw new HttpError(502, r.status === 400 ? 'O WhatsApp recusou a mensagem (conversa ou arquivo inválido).' : 'WhatsApp indisponível agora. Tente de novo.');
  return d;
}

/** Texto curto e tipo de qualquer mensagem da Evolution (o painel não interpreta o objeto cru). */
export function summarize(r: any) {
  const m = r?.message || {};
  const t = r?.messageType || Object.keys(m)[0] || '';
  const inter = m.interactiveMessage;
  const media = t === 'imageMessage' ? 'image' : t === 'videoMessage' ? 'video' : t === 'audioMessage' ? 'audio'
    : t === 'documentMessage' || t === 'documentWithCaptionMessage' ? 'document' : t === 'stickerMessage' ? 'image' : null;
  const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || doc?.caption
    || inter?.body?.text || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title
    || m.templateButtonReplyMessage?.selectedDisplayText || m.buttonsMessage?.contentText || '';
  return {
    id: String(r?.key?.id || ''), fromMe: !!r?.key?.fromMe, at: Number(r?.messageTimestamp || 0) * 1000,
    text: String(text).slice(0, 4000), media, fileName: doc?.fileName ? String(doc.fileName).slice(0, 120) : null,
    status: r?.status || null,
  };
}

export async function whatsappChat(client: SupabaseClient, tenantId: string, op: string, body: any): Promise<Response> {
  if (!OPS.includes(op)) throw new HttpError(404, 'Ação desconhecida.');
  const kind = op !== 'send' ? 'read' : body.file ? MEDIA[String(body.mime || '')] : 'text';
  if (!kind) throw new HttpError(400, 'Envie foto (JPG, PNG, WebP), vídeo (MP4) ou PDF.');
  if (op === 'send' && !body.file && !String(body.text || '').trim()) throw new HttpError(400, 'Escreva a mensagem.');
  const jid = String(body.jid || '');
  if ((op === 'messages' || op === 'send') && !JID.test(jid)) throw new HttpError(400, 'Conversa inválida.');
  const inst = encodeURIComponent(instanceOf(tenantId));

  const gate = async (action: string) => { const { error } = await client.rpc('whatsapp_chat_gate', { p_tenant: tenantId, p_action: action }); if (error) rpcError(error); };
  await gate('read');
  // Envio: só para conversa que já existe neste WhatsApp; confere antes de gastar franquia (o gate consome e audita).
  if (op === 'send') {
    const chats: any[] = await evo(`/chat/findChats/${inst}`, { where: { remoteJid: jid } }, 10000);
    if (!Array.isArray(chats) || !chats.some((c) => c?.remoteJid === jid)) throw new HttpError(404, 'Conversa não encontrada neste WhatsApp.');
    await gate(kind);
  }
  const svc = serviceClient();

  if (op === 'list') {
    const [chats, sent] = await Promise.all([
      evo(`/chat/findChats/${inst}`, {}),
      evo(`/chat/findMessages/${inst}`, { where: { key: { fromMe: true } }, offset: 1000, page: 1 }),
    ]);
    // Conversa -> quem é: pelos avisos que saíram para ela (o WhatsApp esconde o número em conversas @lid).
    const byJid = new Map<string, string[]>();
    for (const r of sent?.messages?.records || []) {
      const j = r?.key?.remoteJid, id = r?.key?.id;
      if (j && id) byJid.set(j, [...(byJid.get(j) || []), id]);
    }
    const refs = [...byJid.values()].flat().slice(0, 2000);
    const { data: who, error: we } = refs.length ? await client.rpc('whatsapp_chat_who', { p_tenant: tenantId, p_refs: refs }) : { data: [], error: null };
    if (we) rpcError(we);
    const byRef = new Map<string, any>((who || []).map((w: any) => [w.ref, w]));
    const rows = (Array.isArray(chats) ? chats : []).filter((c) => JID.test(String(c?.remoteJid || ''))).map((c) => {
      const w = (byJid.get(c.remoteJid) || []).map((id) => byRef.get(id)).find(Boolean);
      const last = c.lastMessage ? summarize(c.lastMessage) : null;
      const phone = w?.phone || (c.remoteJid.endsWith('@s.whatsapp.net') ? `+${c.remoteJid.split('@')[0]}` : null);
      return { jid: c.remoteJid, name: w?.full_name || c.pushName || null, unit: w?.unit || null, phone, unread: Number(c.unreadCount) || 0,
        at: last?.at || Date.parse(c.updatedAt) || 0, last: last && { text: last.text, media: last.media, fromMe: last.fromMe } };
    }).sort((a, b) => b.at - a.at);
    return json({ chats: rows });
  }

  if (op === 'messages') {
    const page = Math.min(Math.max(Number(body.page) || 1, 1), 50);
    const d = await evo(`/chat/findMessages/${inst}`, { where: { key: { remoteJid: jid } }, offset: 50, page });
    const m = d?.messages || {};
    return json({ messages: (m.records || []).map(summarize), pages: Number(m.pages) || 1, page });
  }

  if (op === 'media') {
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw new HttpError(400, 'Mídia inválida.');
    const base = `${tenantId}/in/${id}`;
    // search é prefixo sem distinguir maiúsculas: confere o id exato antes de reaproveitar.
    const { data: cached } = await svc.storage.from(BUCKET).list(`${tenantId}/in`, { search: `${id}.`, limit: 5 });
    const hit = cached?.find((f) => f.name.slice(0, f.name.lastIndexOf('.')) === id);
    let path = hit ? `${tenantId}/in/${hit.name}` : null;
    if (!path) {
      const d = await evo(`/chat/getBase64FromMediaMessage/${inst}`, { message: { key: { id } }, convertToMp4: true }, 45000);
      const mime = String(d?.mimetype || '').split(';')[0];
      if (!d?.base64 || !EXT[mime]) throw new HttpError(415, 'Tipo de arquivo não exibido no painel.');
      path = `${base}.${EXT[mime]}`;
      const up = await svc.storage.from(BUCKET).upload(path, Buffer.from(d.base64, 'base64'), { contentType: mime, upsert: true });
      if (up.error) throw new Error(`storage: ${up.error.message}`);
    }
    const { data: s, error: se } = await svc.storage.from(BUCKET).createSignedUrl(path, 300);
    if (se || !s) throw new Error('storage: url');
    return json({ url: s.signedUrl });
  }

  // send
  const number = jid;
  const text = String(body.text || '').trim().slice(0, 4000);
  if (!body.file) {
    const d = await evo(`/message/sendText/${inst}`, { number, text, options: { linkPreview: false } }, 25000);
    return json({ sent: true, id: d?.key?.id || null });
  }
  const file = String(body.file);
  if (!file.startsWith(`${tenantId}/out/`) || file.includes('..') || !/^[\w./-]{1,200}$/.test(file)) throw new HttpError(400, 'Anexo inválido.');
  const dl = await svc.storage.from(BUCKET).download(file);
  if (dl.error || !dl.data) throw new HttpError(404, 'Anexo não encontrado. Envie de novo.');
  const mime = String(body.mime);
  if (dl.data.type && dl.data.type.split(';')[0] !== mime) throw new HttpError(400, 'Tipo do anexo não confere.');
  const media = Buffer.from(await dl.data.arrayBuffer()).toString('base64');
  try {
    const d = await evo(`/message/sendMedia/${inst}`, { number, mediatype: kind, mimetype: mime, caption: text || undefined,
      fileName: kind === 'document' ? String(body.fileName || 'documento.pdf').replace(/[^\w .()-]/g, '').slice(0, 80) || 'documento.pdf' : undefined,
      media }, 45000);
    return json({ sent: true, id: d?.key?.id || null });
  } finally {
    // O anexo já está na Evolution (ou falhou): não fica guardado no bucket.
    await svc.storage.from(BUCKET).remove([file]).catch(() => {});
  }
}
