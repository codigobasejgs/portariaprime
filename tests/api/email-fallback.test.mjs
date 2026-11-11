// E-mail: Resend principal, Brevo reserva só quando o Resend recusa antes de aceitar (cota/5xx/sem config).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail } from '../../api/_lib/channels.ts';

async function run(env, handler, fn) {
  const saved = { ...process.env }; const fetch0 = globalThis.fetch; const calls = [];
  for (const k of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'BREVO_API_KEY', 'BREVO_FROM_EMAIL']) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = async (url, init) => { const u = String(url); calls.push({ u, body: JSON.parse(init.body), headers: init.headers }); return handler(u); };
  try { return await fn(calls); } finally { globalThis.fetch = fetch0; process.env = saved; }
}
const BOTH = { RESEND_API_KEY: 'rk', RESEND_FROM_EMAIL: 'Portaria Prime <avisos@portariaprime.com.br>', BREVO_API_KEY: 'bk' };
const send = () => sendEmail('m@x.y', 'Assunto', '<p>x</p>', { filename: 'a.pdf', content: new Uint8Array([37, 80]) }, 'Cond A', { text: 't', idempotencyKey: 'job-1' });

test('Resend aceita: Brevo nem é chamado', () => run(BOTH, () => Response.json({ id: 're1' }), async (calls) => {
  assert.deepEqual(await send(), { status: 'accepted', ref: 're1' });
  assert.equal(calls.length, 1);
}));

test('cota do Resend esgotada (429): Brevo envia com o mesmo remetente, anexo e texto', () => run(BOTH,
  (u) => u.includes('resend') ? Response.json({ name: 'daily_quota_exceeded' }, { status: 429 }) : Response.json({ messageId: '<b1@brevo>' }, { status: 201 }),
  async (calls) => {
    assert.deepEqual(await send(), { status: 'accepted', ref: 'brevo:<b1@brevo>' });
    const b = calls[1];
    assert.equal(b.u, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(b.headers['api-key'], 'bk');
    assert.deepEqual(b.body.sender, { email: 'avisos@portariaprime.com.br', name: 'Cond A via Portaria Prime' });
    assert.deepEqual(b.body.to, [{ email: 'm@x.y' }]);
    assert.deepEqual(b.body.attachment, [{ name: 'a.pdf', content: 'JVA=' }]);
    assert.equal(b.body.textContent, 't');
  }));

test('destinatário recusado (422) não vai para a reserva; erro de rede (ambíguo) também não', async () => {
  await run(BOTH, () => Response.json({}, { status: 422 }), async (calls) => {
    assert.equal((await send()).permanent, true); assert.equal(calls.length, 1);
  });
  await run(BOTH, () => { throw new Error('timeout'); }, async (calls) => {
    assert.equal((await send()).status, 'failed'); assert.equal(calls.length, 1, 'pode ter saído: não duplica pela reserva');
  });
});

test('sem Brevo configurado: mantém o erro do Resend; só Brevo configurado: envia por ele', async () => {
  const { BREVO_API_KEY, ...onlyResend } = BOTH;
  await run(onlyResend, () => Response.json({}, { status: 429 }), async () => assert.match((await send()).error, /Resend HTTP 429/));
  await run({ BREVO_API_KEY: 'bk', BREVO_FROM_EMAIL: 'avisos@portariaprime.com.br' }, () => Response.json({ messageId: 'b2' }, { status: 201 }),
    async (calls) => { assert.equal((await send()).status, 'accepted'); assert.equal(calls[0].u, 'https://api.brevo.com/v3/smtp/email'); });
});

test('as duas falham: erro com os dois motivos; reserva sem resposta vira "ambiguous" (fila não repete)', async () => {
  await run(BOTH, (u) => Response.json({}, { status: u.includes('resend') ? 429 : 401 }), async () => {
    const r = await send(); assert.equal(r.status, 'failed'); assert.match(r.error, /Resend HTTP 429.*Brevo HTTP 401/);
  });
  await run(BOTH, (u) => { if (u.includes('resend')) return Response.json({}, { status: 503 }); throw new Error('rede'); }, async () => {
    assert.match((await send()).error, /^ambiguous/);
  });
});
