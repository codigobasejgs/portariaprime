// Conversas do WhatsApp no painel do síndico (/demonstracao, sem rede): lista, abre, responde; celular e desktop.
// Uso: APP=http://127.0.0.1:3017 node tests/e2e/whatsapp-chat-demo.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
for (const [label, viewport] of [['celular', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 860 }]]) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return u.origin !== new URL(APP).origin || /^\/api(\/|$)/.test(u.pathname) ? r.abort() : r.continue(); });
  await page.goto(`${APP}/c/demonstracao/conversas?perfil=admin`);
  await page.getByRole('heading', { name: 'Conversas do WhatsApp' }).waitFor();
  const list = page.getByRole('region', { name: 'Conversas' });
  await list.getByRole('button', { name: /João Silva/ }).click();
  const thread = page.getByRole('region', { name: 'Conversa com João Silva' });
  await thread.getByText('Posso retirar depois das 19h?').waitFor();
  await thread.getByLabel('Mensagem').fill('Pode sim, a portaria fica aberta até as 22h.');
  await thread.getByRole('button', { name: 'Enviar', exact: true }).click();
  await thread.getByText('Pode sim, a portaria fica aberta até as 22h.').waitFor();
  assert.equal(await thread.getByLabel('Mensagem').inputValue(), '');
  // Busca filtra a lista.
  if (label === 'celular') await thread.getByRole('button', { name: 'Voltar para as conversas' }).click();
  await list.getByPlaceholder('Nome, unidade ou telefone').fill('A 102');
  assert.equal(await list.getByRole('button').count(), 1);
  // Item do menu lateral (desktop) aponta para a página.
  if (label === 'desktop') assert.ok(await page.getByRole('link', { name: 'Conversas do WhatsApp' }).count());
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `${label}: sem rolagem horizontal`);
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log(`ok   ${label}`);
}
await browser.close();
console.log('OK whatsapp-chat-demo');
