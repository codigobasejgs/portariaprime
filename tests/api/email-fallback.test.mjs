// E-mail: Brevo principal (300/dia), Resend reserva só quando o Brevo recusa antes de aceitar (cota/5xx/sem config).
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
const BREVO = 'https://api.brevo.com/v3/smtp/email';

test('Brevo aceita primeiro, com remetente do condomínio, anexo e texto; Resend nem é chamado', () => run(BOTH,
  () => Response.json({ messageId: '<b1@brevo>' }, { status: 201 }), async (calls) => {
    assert.deepEqual(await send(), { status: 'accepted', ref: 'brevo:<b1@brevo>' });
    assert.equal(calls.length, 1);
    const b = calls[0];
    assert.equal(b.u, BREVO);
    assert.equal(b.headers['api-key'], 'bk');
    assert.deepEqual(b.body.sender, { email: 'avisos@portariaprime.com.br', name: 'Cond A via Portaria Prime' });
    assert.deepEqual(b.body.to, [{ email: 'm@x.y' }]);
    assert.deepEqual(b.body.attachment, [{ name: 'a.pdf', content: 'JVA=' }]);
    assert.equal(b.body.textContent, 't');
  }));

test('cota do Brevo esgotada (402) ou limite (429): sai pelo Resend com Idempotency-Key', async () => {
  for (const status of [402, 429, 503]) {
    await run(BOTH, (u) => u === BREVO ? Response.json({ code: 'not_enough_credits' }, { status }) : Response.json({ id: 're1' }), async (calls) => {
      assert.deepEqual(await send(), { status: 'accepted', ref: 're1' }, `Brevo ${status}`);
      assert.equal(calls[1].u, 'https://api.resend.com/emails');
      assert.equal(calls[1].headers['Idempotency-Key'], 'job-1');
      assert.equal(calls[1].body.from, '"Cond A via Portaria Prime" <avisos@portariaprime.com.br>');
    });
  }
});

test('destinatário inválido no Brevo não vai para o Resend; erro de rede (ambíguo) também não', async () => {
  await run(BOTH, () => Response.json({ code: 'invalid_parameter', message: 'email is not valid in to' }, { status: 400 }), async (calls) => {
    assert.equal((await send()).permanent, true); assert.equal(calls.length, 1);
  });
  await run(BOTH, () => { throw new Error('timeout'); }, async (calls) => {
    assert.equal((await send()).status, 'failed'); assert.equal(calls.length, 1, 'pode ter saído: não duplica pela reserva');
  });
});

test('sem Brevo configurado: usa só o Resend; sem Resend: mantém o erro do Brevo', async () => {
  const { BREVO_API_KEY, ...onlyResend } = BOTH;
  await run(onlyResend, () => Response.json({ id: 're2' }), async (calls) => {
    assert.deepEqual(await send(), { status: 'accepted', ref: 're2' }); assert.equal(calls[0].u, 'https://api.resend.com/emails');
  });
  await run({ BREVO_API_KEY: 'bk', BREVO_FROM_EMAIL: 'avisos@portariaprime.com.br' }, () => Response.json({}, { status: 402 }),
    async () => assert.match((await send()).error, /Brevo HTTP 402/));
});

test('os dois falham: erro com os dois motivos; reserva sem resposta vira "ambiguous" (fila não repete)', async () => {
  await run(BOTH, (u) => Response.json({}, { status: u === BREVO ? 402 : 429 }), async () => {
    const r = await send(); assert.equal(r.status, 'failed'); assert.match(r.error, /Brevo HTTP 402.*Resend HTTP 429/);
  });
  await run(BOTH, (u) => { if (u === BREVO) return Response.json({}, { status: 503 }); throw new Error('rede'); }, async () => {
    assert.match((await send()).error, /^ambiguous/);
  });
});
