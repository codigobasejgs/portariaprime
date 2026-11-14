// WhatsApp do Portaria Prime IA de cada condomínio (instância ppia-<condomínio> no motor Whaileys):
// painel cria/conecta/desconecta só depois do gate no banco; webhook confere o segredo DA instância,
// atende só autorizados daquele condomínio e fica em silêncio para os demais (mesmo chip da Evolution).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { POST as whatsapp } from '../../api/whatsapp/[action].ts';
import { POST as webhook } from '../../api/webhooks/infinitepay.ts';

const T1 = '11111111-2222-4333-8444-555555555555';
const INST = `ppia-${T1}`;
const TOKEN = 'b'.repeat(64), SECRET = 'c'.repeat(64);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', APP_URL: 'https://portariaprime.com.br',
  WHAILEYS_API_URL: 'https://wh.test', WHAILEYS_PARTNER_KEY: 'p'.repeat(40) };

/** Supabase + motor simulados. channel = linha de assistant_channels (null = ainda não criada). */
async function withEnv(fn, { gate = null, channel = null, motor = {}, links = [] } = {}) {
  const saved = { ...process.env }; Object.assign(process.env, ENV);
  const fetch0 = globalThis.fetch;
  const log = { motor: [], upserts: [], updates: [], sent: [], messages: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); const body = init.body ? JSON.parse(init.body) : null;
    if (u.endsWith('/auth/v1/user')) return Response.json({ id: 'u1', email: 's@x.invalid' });
    if (u.includes('/rpc/assistant_channel_gate')) return gate ? Response.json(gate, { status: 403 }) : Response.json(true);
    if (u.includes('/rest/v1/assistant_channels')) {
      if (init.method === 'POST') { log.upserts.push(body); return new Response(null, { status: 201 }); }
      if (init.method === 'PATCH') { log.updates.push(body); return new Response(null, { status: 204 }); }
      return Response.json(channel ? [channel] : []);
    }
    if (u.includes('/rest/v1/assistant_links')) return Response.json(links.map((p) => ({ phone: p })));
    if (u.includes('/rpc/assistant_resolve')) return Response.json(links.length ? [{ link_id: 'L1', tenant_id: T1, tenant_name: 'Cond A', level: 'basic', role: 'admin', can_approve: true, is_admin: true, full_name: 'Maria', feature_ocr: true }] : []);
    if (u.includes('/rest/v1/assistant_messages')) { log.messages++; return new Response(null, { status: 201 }); }
    if (u.includes('/rest/v1/assistant_sessions')) return init.method === 'GET' || !init.method ? Response.json(null) : new Response(null, { status: 201 });
    if (u.includes('/rpc/assistant_read')) return Response.json({ waiting: 1, overdue_7d: 0, oldest: [] });
    if (u.startsWith('https://wh.test/')) {
      const path = u.slice('https://wh.test'.length);
      log.motor.push({ path, method: init.method || 'GET', key: init.headers?.['x-api-key'], body });
      if (path.endsWith('/send')) { log.sent.push(body); return Response.json({ messageId: 'm1' }); }
      const r = motor[`${init.method || 'GET'} ${path}`];
      return r ? Response.json(r.body, { status: r.status || 200 }) : Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({});
  };
  try { return await fn(log); } finally { globalThis.fetch = fetch0; process.env = saved; }
}
const call = (op, body = {}) => whatsapp(new Request(`https://portariaprime.com.br/api/whatsapp/ia-${op}`,
  { method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: T1, ...body }) }));

test('painel: sem permissão no banco, nada chega ao motor', async () => {
  await withEnv(async (log) => {
    const r = await call('connect');
    assert.equal(r.status, 403); assert.match((await r.json()).error, /gerencia a equipe/);
    assert.equal(log.motor.length, 0);
  }, { gate: { code: '42501', message: 'Somente quem gerencia a equipe conecta o WhatsApp do assistente.' } });
});

test('painel: primeira conexão cria ppia-<condomínio> com a chave de parceiro e guarda token/segredo só no servidor', async () => {
  await withEnv(async (log) => {
    const r = await call('connect', { phone: '(11) 98888-7777' });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(d, { state: 'connecting', qr: 'data:image/png;base64,AAA', pairingCode: 'ABCD1234', phone: null });
    assert.ok(!JSON.stringify(d).includes(TOKEN) && !JSON.stringify(d).includes(SECRET), 'credenciais nunca vão ao navegador');
    const [create, connect] = log.motor;
    assert.deepEqual([create.path, create.key, create.body], ['/instances', 'p'.repeat(40), { name: INST, webhookUrl: 'https://portariaprime.com.br/api/webhooks/whaileys' }]);
    assert.deepEqual([connect.path, connect.key, connect.body], [`/sessions/${INST}/connect`, TOKEN, { phone: '5511988887777' }]);
    assert.equal(log.upserts[0].instance, INST); assert.equal(log.upserts[0].webhook_secret, SECRET);
  }, { motor: {
    'POST /instances': { status: 201, body: { instance: INST, token: TOKEN, webhookSecret: SECRET } },
    [`POST /sessions/${INST}/connect`]: { body: { state: 'connecting', qr: 'data:image/png;base64,AAA', pairingCode: 'ABCD1234', me: null } },
  } });
});

test('painel: telefone inválido é recusado; status conectado mostra o número e envia os autorizados ao motor', async () => {
  const channel = { instance: INST, token: TOKEN, phone: null };
  await withEnv(async (log) => {
    assert.equal((await call('connect', { phone: '123' })).status, 400);
    const r = await (await call('status')).json();
    assert.deepEqual(r, { state: 'open', qr: null, pairingCode: null, phone: '5511988887777' });
    assert.equal(log.updates[0].phone, '5511988887777');
    assert.deepEqual(log.motor.find((m) => m.path.endsWith('/known-phones')).body, { phones: ['5511999990001'] });
  }, { channel, links: ['5511999990001'], motor: {
    [`GET /sessions/${INST}`]: { body: { state: 'open', qr: null, me: { id: '5511988887777:3@s.whatsapp.net' } } },
    [`POST /sessions/${INST}/known-phones`]: { body: { ok: true } },
  } });
});

test('painel: desconectar faz logout na instância do condomínio', async () => {
  await withEnv(async (log) => {
    const r = await (await call('logout')).json();
    assert.equal(r.state, 'disconnected');
    assert.deepEqual(log.motor.map((m) => `${m.method} ${m.path} ${m.key === TOKEN}`), [`DELETE /sessions/${INST} true`]);
    assert.equal(log.updates[0].phone, null);
  }, { channel: { instance: INST, token: TOKEN, phone: '5511988887777' }, motor: { [`DELETE /sessions/${INST}`]: { body: { ok: true } } } });
});

// ---------------------------------------------------------------- webhook do número do condomínio
const hook = (body, secret = SECRET) => {
  const raw = JSON.stringify(body); const ts = String(Date.now());
  return webhook(new Request('https://portariaprime.com.br/api/webhooks/infinitepay?a=whaileys', { method: 'POST', body: raw,
    headers: { 'x-whaileys-timestamp': ts, 'x-whaileys-signature': createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex') } }));
};
const msg = (id, from = '5511999990001') => ({ instanceKey: INST, key: { id, remoteJid: `${from}@s.whatsapp.net`, fromMe: false }, message: { conversation: 'oi' } });
const row = { tenant_id: T1, token: TOKEN, webhook_secret: SECRET };

test('webhook do condomínio: segredo de outra instância = 401; autorizado recebe o menu pela instância do condomínio', async () => {
  await withEnv(async (log) => {
    assert.equal((await hook(msg('W0001'), 'd'.repeat(64))).status, 401);
    const ok = await hook(msg('W0002'));
    assert.equal(ok.status, 200);
    assert.match(log.sent[0].text, /Portaria Prime IA · Cond A/);
    assert.ok(log.motor.filter((m) => m.path.endsWith('/send')).every((m) => m.path === `/sessions/${INST}/send` && m.key === TOKEN));
  }, { channel: row, links: ['5511999990001'] });
});

test('webhook do condomínio: morador (não autorizado) não recebe nada e o telefone não é gravado', async () => {
  await withEnv(async (log) => {
    const r = await hook(msg('W0003', '5511977776666'));
    assert.deepEqual(await r.json(), { ignored: true });
    assert.equal(log.sent.length, 0); assert.equal(log.messages, 0);
  }, { channel: row, links: [] });
});

test('webhook: instância desconhecida ou fora do padrão é ignorada sem consultar o banco', async () => {
  await withEnv(async () => {
    assert.deepEqual(await (await hook({ ...msg('W0004'), instanceKey: 'agendafacil265' })).json(), { ignored: true });
  });
});
