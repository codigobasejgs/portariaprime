// Testes do contrato InfinitePay e templates. MOCK DO PROVEDOR (somente teste):
// nenhuma chamada real à InfinitePay é feita aqui.
// Uso: npx tsx --test tests/api/billing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INFINITEPAY_HANDLE = '$portaria-prime-teste';
const ip = await import('../../api/_lib/infinitepay.ts');
const tpl = await import('../../api/_lib/templates.ts');

function mockFetch(responder) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responder(url, JSON.parse(init.body));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  f.calls = calls;
  return f;
}

test('createCheckoutLink: handle sem $, preço em centavos do servidor, URLs e order_nsu', async () => {
  const f = mockFetch(() => ({ body: { url: 'https://checkout.infinitepay.io/x/abc' } }));
  const url = await ip.createCheckoutLink({ orderNsu: 'pp-1', amountCents: 14900, description: 'Plano', redirectUrl: 'https://app/r', webhookUrl: 'https://app/w' }, f);
  assert.equal(url, 'https://checkout.infinitepay.io/x/abc');
  assert.equal(f.calls[0].url, 'https://api.checkout.infinitepay.io/links');
  assert.deepEqual(f.calls[0].body.items, [{ quantity: 1, price: 14900, description: 'Plano' }]);
  assert.equal(f.calls[0].body.handle, 'portaria-prime-teste');
  assert.equal(f.calls[0].body.order_nsu, 'pp-1');
});

test('createCheckoutLink: erro do provedor não inventa link', async () => {
  const f = mockFetch(() => ({ status: 422, body: { error: 'x' } }));
  await assert.rejects(ip.createCheckoutLink({ orderNsu: 'pp-1', amountCents: 1, description: 'd', redirectUrl: 'https://a', webhookUrl: 'https://b' }, f), /recusou/);
});

test('paymentCheck: envia os 4 campos documentados e normaliza a resposta', async () => {
  const f = mockFetch(() => ({ body: { success: true, paid: true, amount: 1500, paid_amount: 1510, installments: 1, capture_method: 'pix' } }));
  const r = await ip.paymentCheck({ orderNsu: 'o', transactionNsu: 't', slug: 's' }, f);
  assert.deepEqual(f.calls[0].body, { handle: 'portaria-prime-teste', order_nsu: 'o', transaction_nsu: 't', slug: 's' });
  assert.equal(r.paid, true);
  assert.equal(r.paid_amount, 1510);
});

test('parseWebhook: exige order_nsu, transaction_nsu e invoice_slug; ignora lixo', () => {
  assert.equal(ip.parseWebhook({ amount: 1 }), null);
  assert.equal(ip.parseWebhook(null), null);
  const ok = ip.parseWebhook({ invoice_slug: 'abc', amount: 1000, paid_amount: 1010, installments: 1, capture_method: 'credit_card',
    transaction_nsu: 'UUID', order_nsu: 'pp-1', receipt_url: 'javascript:alert(1)', extra: 'x' });
  assert.equal(ok.order_nsu, 'pp-1');
  assert.equal(ok.receipt_url, null);
  assert.equal(ok.extra, undefined);
});

test('verifyAndApply: webhook forjado (provedor diz não pago) não aplica', async () => {
  const { verifyAndApply } = await import('../../api/_lib/payments.ts');
  let applied = false;
  const svc = { rpc: async () => { applied = true; return { data: {}, error: null }; } };
  const f = mockFetch(() => ({ body: { success: true, paid: false } }));
  const r = await verifyAndApply(svc, { orderNsu: 'o', transactionNsu: 't', slug: 's' }, f);
  assert.equal(r.result, 'pending');
  assert.equal(applied, false);
});

test('templates escapam HTML e removem formatação injetada no WhatsApp', () => {
  const ctx = { tenant_name: '<script>x</script>', tenant_slug: 'a', timezone: 'America/Sao_Paulo',
    package: { carrier: '*Correios*', tracking_code: 'AB<1>', received_at: new Date().toISOString(), unit: 'A 101' } };
  const m = tpl.render('package_received', ctx, {}, 'https://app.test');
  const html = tpl.emailHtml(ctx, m);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!m.whatsapp.includes('*Correios*'));
  assert.ok(m.whatsapp.includes('https://app.test/c/a/morador'));
});
