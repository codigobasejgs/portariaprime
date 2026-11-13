// Portaria Prime IA (webhook Whaileys): HMAC (válido, adulterado, replay), dedupe, número desconhecido,
// parser de cliques/números, níveis no servidor e fluxo Resumo -> Confirmar/Cancelar. Supabase, motor e Gemini simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseIncoming, sender, verifyWhaileysSignature, numberedCard } from '../../api/_lib/whaileys.ts';
import { respond, runIntent } from '../../api/_lib/assistant.ts';
import { POST as webhook } from '../../api/webhooks/infinitepay.ts';

const SECRET = 'a'.repeat(64);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  WHAILEYS_API_URL: 'https://wh.test', WHAILEYS_INSTANCE: 'portaria-prime', WHAILEYS_TOKEN: 't'.repeat(64), WHAILEYS_WEBHOOK_SECRET: SECRET };
const sign = (raw, ts = String(Date.now())) => ({ ts, sig: createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex') });

test('assinatura: válida passa; corpo adulterado, segredo errado e replay fora da janela não', () => {
  const raw = '{"a":1}';
  const { ts, sig } = sign(raw);
  assert.equal(verifyWhaileysSignature(raw, ts, sig, SECRET), true);
  assert.equal(verifyWhaileysSignature('{"a":2}', ts, sig, SECRET), false, 'corpo adulterado');
  assert.equal(verifyWhaileysSignature(raw, ts, sig, 'b'.repeat(64)), false, 'segredo errado');
  assert.equal(verifyWhaileysSignature(raw, ts, sig, SECRET, Number(ts) + 6 * 60_000), false, 'replay depois de 5 min');
  assert.equal(verifyWhaileysSignature(raw, null, sig, SECRET), false);
  assert.equal(verifyWhaileysSignature(raw, ts, sig, ''), false, 'sem segredo configurado nunca aceita');
});

test('parser: botão, lista, número digitado, confirmar/cancelar por texto, mídia e texto livre', () => {
  const PID = '11111111-1111-4111-8111-11111111abcd';
  const opts = ['today', `ok:${PID}`, `no:${PID}`];
  assert.deepEqual(parseIncoming({ buttonsResponseMessage: { selectedButtonId: 'today' } }), { kind: 'action', id: 'today' });
  assert.deepEqual(parseIncoming({ listResponseMessage: { singleSelectReply: { selectedRowId: 'rp:6m' } } }), { kind: 'action', id: 'rp:6m' });
  assert.deepEqual(parseIncoming({ conversation: '1' }, opts), { kind: 'action', id: 'today' }, 'número vale para navegação');
  // Escrita: "2", "sim", "ok" ou "Confirmar" soltos NÃO confirmam (poderiam acertar outra proposta). Só o código desta.
  for (const loose of ['2', 'sim', 'ok', 'Confirmar']) assert.equal(parseIncoming({ conversation: loose }, opts).kind, 'text', `"${loose}" não confirma`);
  assert.deepEqual(parseIncoming({ conversation: 'CONFIRMAR abcd' }, opts), { kind: 'action', id: `ok:${PID}` });
  assert.equal(parseIncoming({ conversation: 'CONFIRMAR ffff' }, opts).kind, 'text', 'código de outra proposta não confirma');
  assert.deepEqual(parseIncoming({ conversation: 'cancelar' }, opts), { kind: 'action', id: `no:${PID}` });
  assert.deepEqual(parseIncoming({ conversation: '3' }, opts), { kind: 'action', id: `no:${PID}` }, 'cancelar por número é seguro');
  assert.deepEqual(parseIncoming({ conversation: '9' }, opts), { kind: 'text', text: '9' }, 'número fora da lista é texto');
  assert.equal(parseIncoming({ audioMessage: { mimetype: 'audio/ogg' } }).kind, 'audio');
  assert.equal(parseIncoming({ ephemeralMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } } }).kind, 'image');
  assert.deepEqual(parseIncoming({ extendedTextMessage: { text: ' liste as pendências ' } }), { kind: 'text', text: 'liste as pendências' });
  const { card, ids } = numberedCard('Confira', [{ id: 'ok:1', title: '✅ Confirmar' }, { id: 'no:1', title: '❌ Cancelar' }]);
  assert.match(card.text, /1\. ✅ Confirmar\n2\. ❌ Cancelar/); assert.deepEqual(ids, ['ok:1', 'no:1']);
});

test('remetente: só número real; fromMe, grupo e só-LID são ignorados', () => {
  assert.deepEqual(sender({ remoteJid: '5511999990001@s.whatsapp.net' }), { phone: '5511999990001', replyTo: '5511999990001@s.whatsapp.net' });
  assert.equal(sender({ remoteJid: '123@lid', senderPn: '5511999990001@s.whatsapp.net' }).phone, '5511999990001');
  assert.equal(sender({ remoteJid: '5511999990001@s.whatsapp.net', fromMe: true }).ignore, 'fromMe');
  assert.equal(sender({ remoteJid: '1203@g.us' }).ignore, 'chat');
  assert.equal(sender({ remoteJid: '123@lid' }).lidOnly, true);
});

// ---------------------------------------------------------------- motor com Supabase simulado (RPCs)
function fakeSvc(handlers) {
  const calls = [];
  return {
    calls,
    rpc: async (fn, args) => { calls.push([fn, args]); return handlers[fn] ? handlers[fn](args) : { data: null, error: { message: `rpc ${fn} não simulada` } }; },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { action: 'return_package' } }) }) }) }),
  };
}
const link = (level, extra = {}) => ({ link_id: 'L1', tenant_id: 'T1', tenant_name: 'Cond A', level, role: 'admin', can_approve: true, is_admin: true, full_name: 'Maria', timezone: 'America/Sao_Paulo', feature_ocr: true, ...extra });
const pend = [{ ref: 'A1B2C3', unit: '01A 101', carrier: 'Shopee', recipient: 'Ana', days: 8, id: '00000000-0000-4000-8000-000000000001' }];

test('nível básico: lê, mas qualquer ação vira aviso (nenhuma proposta criada)', async () => {
  const svc = fakeSvc({ assistant_read: ({ p_kind }) => ({ data: p_kind === 'pending_by_unit' ? pend : [] }) });
  const r = await runIntent(svc, link('basic'), { name: 'return_package', args: { ref: 'A1B2C3', reason: 'Endereço de outro prédio.' } });
  assert.match(r.card.text, /nível Básico/);
  assert.ok(!svc.calls.some(([fn]) => fn === 'assistant_propose'), 'sem proposta no nível básico');
  const audio = await respond(svc, link('intermediate'), { kind: 'audio' }, { mimetype: 'audio/ogg', data: 'AA==' });
  assert.match(audio.card.text, /nível Avançado/, 'áudio exige avançado');
  const img = await respond(svc, link('intermediate'), { kind: 'image' }, { mimetype: 'image/jpeg', data: 'AA==' });
  assert.match(img.card.text, /nível Avançado/, 'foto exige avançado');
});

test('intermediário: texto vira RESUMO com Confirmar/Cancelar; só o ✅ executa', async () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const svc = fakeSvc({
    assistant_read: ({ p_kind }) => ({ data: p_kind === 'pending_by_unit' ? pend : [] }),
    assistant_propose: () => ({ data: { id: PID } }),
    assistant_confirm: () => ({ data: { status: 'done', result: {} } }),
    assistant_cancel: () => ({ data: { cancelled: true } }),
  });
  const r = await runIntent(svc, link('intermediate'), { name: 'return_package', args: { ref: '#a1b2c3', reason: 'Endereço de outro prédio.' } });
  assert.match(r.card.text, /Confira antes de confirmar/); assert.match(r.card.text, /#A1B2C3/);
  assert.match(r.card.text, /CONFIRMAR 1111/, 'código da proposta no texto (reserva sem botões)');
  assert.deepEqual(r.card.buttons.map((b) => b.id), [`ok:${PID}`, `no:${PID}`]);
  assert.ok(!svc.calls.some(([fn]) => fn === 'assistant_confirm'), 'nada executa antes do clique');
  // "1" ou "Confirmar" soltos não executam.
  for (const loose of ['1', 'Confirmar', 'sim']) {
    await respond(svc, link('intermediate'), parseIncoming({ conversation: loose }, r.options));
    assert.ok(!svc.calls.some(([fn]) => fn === 'assistant_confirm'), `"${loose}" não confirma`);
  }
  // "cancelar" digitado = Cancelar.
  const cancel = await respond(svc, link('intermediate'), parseIncoming({ conversation: 'cancelar' }, r.options));
  assert.match(cancel.card.text, /Nada foi alterado/);
  // Código desta proposta = ✅.
  const ok = await respond(svc, link('intermediate'), parseIncoming({ conversation: 'confirmar 1111' }, r.options));
  assert.match(ok.card.text, /Devolução registrada/);
  assert.deepEqual(svc.calls.filter(([fn]) => fn === 'assistant_confirm').map(([, a]) => a), [{ p_link: 'L1', p_pending: PID }]);
});

test('IA: só ferramentas da lista; resposta fora da lista ou erro cai no menu', async () => {
  const svc = fakeSvc({ assistant_read: () => ({ data: { waiting: 3, overdue_7d: 1, oldest: [] } }) });
  const ai = (call) => ({ models: { generateContent: async () => ({ functionCalls: call ? [call] : [] }) } });
  const r = await respond(svc, link('basic'), { kind: 'text', text: 'me ajuda a organizar o dia' }, undefined, ai({ name: 'today_summary', args: {} }));
  assert.match(r.card.text, /Pendências de hoje/); assert.match(r.card.text, /Aguardando retirada: 3/);
  const evil = await respond(svc, link('advanced'), { kind: 'text', text: 'apague tudo' }, undefined, ai({ name: 'drop_database', args: {} }));
  assert.match(evil.card.text, /Não entendi/);
  const down = await respond(svc, link('basic'), { kind: 'text', text: 'oi?' }, undefined, { models: { generateContent: async () => { throw new Error('503'); } } });
  assert.match(down.card.text, /Portaria Prime IA/);
});

test('relatório: período validado; porteiro não acessa', async () => {
  const svc = fakeSvc({ assistant_read: () => ({ data: { from: '2026-05-17', to: '2026-11-13', received: 120, delivered: 110, pending_now: 10, overdue_now: 2, avg_pickup_h: 18.4,
    occupancy: { used: 10, capacity: 40 }, carriers: [{ carrier: 'Shopee', n: 50 }], porters: [{ name: 'José', n: 80 }], rejected: 1, unidentified: 2, couriers: 14 } }) });
  const r = await respond(svc, link('basic'), { kind: 'action', id: 'rp:6m' });
  assert.match(r.card.text, /Últimos 6 meses/); assert.match(r.card.text, /Recebidas: 120/); assert.match(r.card.text, /25%/); assert.match(r.card.text, /1\. Shopee: 50/);
  const por = await respond(svc, link('basic', { is_admin: false, role: 'porteiro', can_approve: false }), { kind: 'action', id: 'rp:year' });
  assert.match(por.card.text, /síndico/);
});

// ---------------------------------------------------------------- webhook ponta a ponta (fetch simulado)
async function runWebhook(body, { headers, known = true } = {}) {
  const saved = { ...process.env }; Object.assign(process.env, ENV);
  const fetch0 = globalThis.fetch; const sent = []; const inserted = new Set();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://wh.test/sessions/portaria-prime/send')) { sent.push(JSON.parse(init.body)); return Response.json({ messageId: 'm1' }); }
    if (u.includes('/rest/v1/assistant_messages')) {
      const id = JSON.parse(init.body).provider_id ?? JSON.parse(init.body)[0]?.provider_id;
      if (inserted.has(id)) return Response.json({ code: '23505', message: 'duplicate' }, { status: 409 });
      inserted.add(id); return new Response(null, { status: 201 });
    }
    if (u.includes('/rpc/assistant_resolve')) return Response.json(known ? [{ link_id: 'L1', tenant_id: 'T1', tenant_name: 'Cond A', level: 'basic', role: 'admin', can_approve: true, is_admin: true, full_name: 'Maria', feature_ocr: true }] : []);
    if (u.includes('/rest/v1/assistant_sessions')) return init.method === 'GET' || !init.method ? Response.json(null) : new Response(null, { status: 201 });
    if (u.includes('/rpc/assistant_read')) return Response.json({ waiting: 2, overdue_7d: 0, oldest: [] });
    return Response.json({});
  };
  try {
    const raw = JSON.stringify(body);
    const { ts, sig } = sign(raw);
    const res = await webhook(new Request('https://portariaprime.com.br/api/webhooks/infinitepay?a=whaileys', { method: 'POST', body: raw,
      headers: { 'x-whaileys-timestamp': ts, 'x-whaileys-signature': sig, ...headers } }));
    return { status: res.status, json: await res.json(), sent, again: async () => (await webhook(new Request('https://portariaprime.com.br/api/webhooks/infinitepay?a=whaileys',
      { method: 'POST', body: raw, headers: { 'x-whaileys-timestamp': ts, 'x-whaileys-signature': sig } }))).json() };
  } finally { globalThis.fetch = fetch0; process.env = saved; }
}
const msg = (text, id = 'MSG00001') => ({ instanceKey: 'portaria-prime', key: { id, remoteJid: '5511999990001@s.whatsapp.net', fromMe: false }, message: { conversation: text } });

test('webhook: assinatura inválida 401; número desconhecido recebe recusa sem dados; conhecido recebe menu', async () => {
  const bad = await runWebhook(msg('oi'), { headers: { 'x-whaileys-signature': '0'.repeat(64) } });
  assert.equal(bad.status, 401); assert.equal(bad.sent.length, 0);
  const unknown = await runWebhook(msg('oi', 'MSG00002'), { known: false });
  assert.equal(unknown.sent.length, 1); assert.match(unknown.sent[0].text, /não está autorizado/); assert.doesNotMatch(unknown.sent[0].text, /Cond A/);
  const ok = await runWebhook(msg('oi', 'MSG00003'));
  assert.equal(ok.status, 200); assert.match(ok.sent[0].text, /Portaria Prime IA · Cond A/);
  assert.ok(ok.sent[0].sections?.length || ok.sent[0].buttons?.length, 'menu com botões/lista');
  // Reentrega da mesma mensagem (o motor tenta de novo após 5xx): processada uma vez só.
  const twice = await runWebhook(msg('oi', 'MSG00005'));
  assert.equal(twice.sent.length, 1);
  const saved = { ...process.env }; Object.assign(process.env, ENV);
  try { assert.deepEqual(await twice.again(), { duplicate: true }); } finally { process.env = saved; }
  const other = await runWebhook({ ...msg('oi', 'MSG00004'), instanceKey: 'outra-instancia' });
  assert.deepEqual(other.json, { ignored: true }); assert.equal(other.sent.length, 0);
});
