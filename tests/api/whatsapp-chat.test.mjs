// Conversas do WhatsApp no painel (/api/whatsapp/chat-*): gate no banco antes da Evolution; envio só para conversa que
// já existe na instância do condomínio, franquia consumida só depois disso; anexo só da pasta out/ do próprio condomínio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../../api/whatsapp/[action].ts';
import { summarize } from '../../api/_lib/whatsapp-chat.ts';

const T = '11111111-2222-4333-8444-555555555555', OTHER = '99999999-2222-4333-8444-555555555555';
const JID = '123456789012345@lid';
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', EVOLUTION_API_URL: 'https://evo.test', EVOLUTION_API_KEY: 'k' };

async function run(action, body, { gate = null, chats = [{ remoteJid: JID }], state = 'open' } = {}) {
  const saved = { ...process.env }; Object.assign(process.env, ENV);
  const fetch0 = globalThis.fetch;
  const log = { gates: [], evo: [], removed: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); const b = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (u.endsWith('/auth/v1/user')) return Response.json({ id: 'u1' });
    if (u.includes('/rpc/whatsapp_chat_gate')) { log.gates.push(b.p_action); return gate && gate[b.p_action] ? Response.json(gate[b.p_action], { status: 400 }) : Response.json(true); }
    if (u.includes('/rpc/whatsapp_chat_who')) return Response.json([{ ref: 'R1', phone: '+5511988887777', full_name: 'Ana', unit: 'A 101' }]);
    if (u.includes('/storage/v1/object/tenant-chat/') && (init.method || 'GET') === 'GET') return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
    if (u.includes('/storage/v1/object/tenant-chat') && init.method === 'DELETE') { log.removed.push(b); return Response.json([]); }
    if (u.startsWith('https://evo.test/')) {
      const p = u.slice('https://evo.test'.length); log.evo.push({ p, b });
      if (p.startsWith('/instance/connectionState/')) return Response.json({ instance: { state } });
      if (p.startsWith('/chat/findChats/')) return Response.json(b?.where?.remoteJid ? chats.filter((c) => c.remoteJid === b.where.remoteJid) : [{ remoteJid: JID, pushName: 'Ana W', unreadCount: 2, updatedAt: '2026-11-17T10:00:00Z', lastMessage: { key: { id: 'X', fromMe: false }, messageType: 'conversation', message: { conversation: 'oi' }, messageTimestamp: 1763373600 } }]);
      if (p.startsWith('/chat/findMessages/')) return Response.json({ messages: { total: 1, pages: 1, records: [{ key: { id: 'R1', fromMe: true, remoteJid: JID }, messageType: 'conversation', message: { conversation: 'aviso' }, messageTimestamp: 1763370000 }] } });
      if (p.startsWith('/message/')) return Response.json({ key: { id: 'NEW1' } });
    }
    return Response.json({ message: 'unexpected ' + u }, { status: 500 });
  };
  try {
    const r = await POST(new Request(`https://app.test/api/whatsapp/${action}`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: T, ...body }) }));
    return { status: r.status, body: await r.json(), log };
  } finally { globalThis.fetch = fetch0; process.env = saved; }
}

test('lista: identifica a conversa pelo aviso que saiu para ela', async () => {
  const r = await run('chat-list', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.log.gates, ['read']);
  assert.deepEqual([r.body.chats[0].name, r.body.chats[0].unit, r.body.chats[0].unread, r.body.chats[0].last.text], ['Ana', 'A 101', 2, 'oi']);
  assert.ok(r.log.evo.every((e) => e.p.endsWith('/pp-11111111-5555')), 'só a instância do condomínio');
});

test('sem permissão: nada chega à Evolution', async () => {
  const r = await run('chat-list', {}, { gate: { read: { code: '42501', message: 'Requer permissão de configurações e plano com WhatsApp.' } } });
  assert.equal(r.status, 403);
  assert.equal(r.log.evo.length, 0);
});

test('envio: só conversa existente, franquia depois da conferência', async () => {
  const ok = await run('chat-send', { jid: JID, text: 'Olá' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.log.gates, ['read', 'text']);
  assert.equal(ok.log.evo.at(-1).b.number, JID);
  const novo = await run('chat-send', { jid: '5511999990000@s.whatsapp.net', text: 'spam' });
  assert.equal(novo.status, 404);
  assert.deepEqual(novo.log.gates, ['read'], 'não consome franquia');
  assert.ok(!novo.log.evo.some((e) => e.p.startsWith('/message/')));
  assert.equal((await run('chat-send', { jid: 'x@g.us', text: 'a' })).status, 400, 'grupo ou jid inválido');
  assert.equal((await run('chat-send', { jid: JID, text: '  ' })).status, 400);
});

test('WhatsApp desconectado: avisa o motivo, sem franquia nem envio', async () => {
  const r = await run('chat-send', { jid: JID, file: `${T}/out/a.mp4`, mime: 'video/mp4' }, { state: 'close' });
  assert.equal(r.status, 409);
  assert.match(r.body.error || r.body.message, /desconectado/);
  assert.deepEqual(r.log.gates, ['read']);
  assert.ok(!r.log.evo.some((e) => e.p.startsWith('/message/')));
});

test('anexo: só da pasta out/ do condomínio, tipo permitido, removido depois', async () => {
  const ok = await run('chat-send', { jid: JID, file: `${T}/out/a.jpg`, mime: 'image/jpeg', text: 'foto' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.log.gates, ['read', 'image']);
  const sent = ok.log.evo.at(-1);
  assert.deepEqual([sent.p.startsWith('/message/sendMedia/'), sent.b.mediatype, sent.b.caption], [true, 'image', 'foto']);
  assert.equal(ok.log.removed.length, 1);
  for (const file of [`${OTHER}/out/a.jpg`, `${T}/in/a.jpg`, `${T}/out/../../x.jpg`]) {
    assert.equal((await run('chat-send', { jid: JID, file, mime: 'image/jpeg' })).status, 400, file);
  }
  assert.equal((await run('chat-send', { jid: JID, file: `${T}/out/a.exe`, mime: 'application/x-msdownload' })).status, 400);
});

test('resumo da mensagem da Evolution', () => {
  assert.deepEqual(summarize({ key: { id: 'A', fromMe: false }, messageType: 'imageMessage', message: { imageMessage: { caption: 'cx' } }, messageTimestamp: 10 }),
    { id: 'A', fromMe: false, at: 10000, text: 'cx', media: 'image', fileName: null, status: null });
  assert.equal(summarize({ key: { id: 'B' }, messageType: 'interactiveMessage', message: { interactiveMessage: { body: { text: 'aviso' } } } }).text, 'aviso');
  assert.equal(summarize({ key: { id: 'C' }, messageType: 'documentMessage', message: { documentMessage: { fileName: 'c.pdf' } } }).fileName, 'c.pdf');
});
