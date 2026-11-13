/** Formato das mensagens do assistente no WhatsApp (puro: servidor e simulador da /demonstracao). */
export interface Card {
  text: string;
  buttons?: { id: string; title: string }[];
  sections?: { title: string; rows: { id: string; title: string; description?: string }[] }[];
  buttonText?: string;
}

// ------------------------------------------------------------------------- mensagem
export type Incoming =
  | { kind: 'action'; id: string }
  | { kind: 'text'; text: string }
  | { kind: 'audio' | 'image' | 'document'; mimetype?: string; caption?: string; fileName?: string }
  | { kind: 'ignored' };

const unwrap = (m: any) => m?.ephemeralMessage?.message ?? m?.viewOnceMessage?.message ?? m?.viewOnceMessageV2?.message ?? m?.documentWithCaptionMessage?.message ?? m;
function nativeFlowId(params: unknown) {
  if (typeof params !== 'string') return undefined;
  try { return (JSON.parse(params) as { id?: string }).id; } catch { return undefined; }
}

/**
 * Proto do WhatsApp → evento. Clique em botão/lista vira o id; "1", "2"... viram a opção numerada do último card
 * (texto de reserva quando o aparelho não mostra botões); "confirmar"/"cancelar" digitados valem como o botão.
 */
export function parseIncoming(raw: unknown, numbered: string[] = []): Incoming {
  if (!raw || typeof raw !== 'object') return { kind: 'ignored' };
  const m = unwrap(raw);
  const id = m.buttonsResponseMessage?.selectedButtonId ?? m.templateButtonReplyMessage?.selectedId
    ?? m.listResponseMessage?.singleSelectReply?.selectedRowId ?? nativeFlowId(m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson);
  if (typeof id === 'string' && id) return { kind: 'action', id: id.slice(0, 200) };
  if (m.audioMessage) return { kind: 'audio', mimetype: m.audioMessage.mimetype };
  if (m.imageMessage) return { kind: 'image', mimetype: m.imageMessage.mimetype, caption: m.imageMessage.caption };
  if (m.documentMessage) return { kind: 'document', mimetype: m.documentMessage.mimetype, caption: m.documentMessage.caption, fileName: m.documentMessage.fileName };
  const text = String(m.conversation ?? m.extendedTextMessage?.text ?? '').trim();
  if (!text) return { kind: 'ignored' };
  // Confirmar uma escrita por texto exige o código da PRÓPRIA proposta ("CONFIRMAR 4F2A"): um "1" ou "sim" solto
  // poderia confirmar uma proposta mais nova cujo resumo não chegou. Cancelar não grava nada: "2"/"cancelar" bastam.
  const code = /^confirm(?:ar|o|a)?\s+([0-9a-f]{4})$/i.exec(text)?.[1]?.toLowerCase();
  if (code) {
    const hit = numbered.find((o) => o.startsWith('ok:') && confirmCode(o.slice(3)) === code);
    if (hit) return { kind: 'action', id: hit };
  }
  const n = /^\d{1,2}$/.test(text) ? Number(text) : 0;
  if (n >= 1 && n <= numbered.length && !numbered[n - 1].startsWith('ok:')) return { kind: 'action', id: numbered[n - 1] };
  const typed = /^(cancelar|cancela|n[ãa]o)$/i.test(text) && numbered.find((o) => o.startsWith('no:'));
  if (typed) return { kind: 'action', id: typed };
  return { kind: 'text', text: text.slice(0, 1000) };
}

/** Código curto da proposta (4 hex do id): confirmação por texto quando o aparelho não mostra botões. */
export const confirmCode = (pendingId: string) => pendingId.replace(/-/g, '').slice(-4).toLowerCase();

/** Card com as opções também numeradas no texto (reserva se os botões não aparecerem). Devolve os ids na ordem. */
export function numberedCard(text: string, options: { id: string; title: string }[], asList = false): { card: Card; ids: string[] } {
  const opts = options.slice(0, asList ? 10 : 3);
  const body = `${text}\n\n${opts.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}`.slice(0, 3900);
  const card: Card = asList
    ? { text: body, buttonText: 'Ver opções', sections: [{ title: 'Opções', rows: opts.map((o) => ({ id: o.id, title: o.title.slice(0, 24) })) }] }
    : { text: body, buttons: opts.map((o) => ({ id: o.id, title: o.title.slice(0, 20) })) };
  return { card, ids: opts.map((o) => o.id) };
}
