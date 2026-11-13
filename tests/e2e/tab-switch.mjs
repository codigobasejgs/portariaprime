// Troca de aba no NAVEGADOR REAL contra Supabase LOCAL (dados do laboratório do quiosque).
// Achado: ao voltar à aba, o Supabase Auth reemite SIGNED_IN com a mesma sessão e o app zerava o
// contexto, remontando a tela (formulário preenchido perdido, tela piscando com "Carregando…").
// Verifica: sem reload, sem remontagem, formulário preservado, sem pedido extra de my_context.
//   PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/tab-switch.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP) throw new Error('Defina PP_E2E_ALLOW=1 e APP.');
assertLocalSupabase(SUPABASE_URL);
const lab = JSON.parse(readFileSync('tests/evidence/kiosk-lab.json', 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const contextCalls = [];
page.on('request', (r) => { if (r.url().includes('/rpc/my_context')) contextCalls.push(r.url()); });
await page.goto(`${APP}/entrar?next=/c/${lab.slug}/portaria`);
await page.getByLabel('E-mail').fill(lab.porteiro.email);
await page.getByLabel('Senha').fill(lab.porteiro.password);
await page.getByRole('button', { name: 'Entrar' }).click();
await page.getByRole('heading', { name: 'Encomendas' }).first().waitFor();
await page.waitForTimeout(1500);

// Marca da instância atual da página: some em reload.
await page.evaluate(() => { window.__ppMark = 'viva'; });
await page.getByRole('button', { name: 'Receber encomenda' }).click();
await page.getByLabel('Nome do entregador (obrigatório)').fill('Entregador Lab');
await page.getByRole('button', { name: 'Avançar', exact: true }).click();
const field = page.getByLabel('Rastreio', { exact: true });
await field.fill('BR123TESTE');
const before = contextCalls.length;

// Saída e volta da aba (o mesmo sinal que o navegador manda ao trocar de aba ou bloquear o celular).
const flip = (state) => page.evaluate((s) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
  // Como o navegador real: evento no document que borbulha até window (o Supabase Auth escuta em window).
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  if (s === 'visible') window.dispatchEvent(new Event('focus'));
}, state);
for (let i = 0; i < 3; i++) { await flip('hidden'); await page.waitForTimeout(800); await flip('visible'); await page.waitForTimeout(2500); }

assert.equal(await page.evaluate(() => window.__ppMark), 'viva', 'sem recarregamento completo da página');
assert.equal(await field.inputValue(), 'BR123TESTE', 'formulário preenchido preservado');
assert.equal(await page.getByText('Carregando condomínio').count(), 0, 'sem tela de carregamento ao voltar');
assert.equal(contextCalls.length - before, 0, 'voltar à aba não recarrega o contexto do usuário');
assert.match(page.url(), new RegExp(`/c/${lab.slug}/portaria`), 'rota mantida');

// Logout e login de OUTRO usuário continuam recarregando o contexto (não pode herdar o anterior).
await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
await page.getByRole('button', { name: /conta|perfil|usuário/i }).first().click().catch(() => {});
const sair = page.getByRole('button', { name: /^Sair/ }).or(page.getByRole('menuitem', { name: /^Sair/ }));
await sair.first().click();
await page.getByLabel('E-mail').waitFor();
await page.goto(`${APP}/entrar?next=/c/${lab.slug}/portaria`);
await page.getByLabel('E-mail').fill(lab.porteiro2.email);
await page.getByLabel('Senha').fill(lab.porteiro2.password);
await page.getByRole('button', { name: 'Entrar' }).click();
await page.getByRole('heading', { name: 'Encomendas' }).first().waitFor();
const who = await page.evaluate(async () => (await (await import('/src/lib/supabase.ts')).supabase.auth.getUser()).data.user?.email);
assert.equal(who, lab.porteiro2.email, 'outro usuário entra com o próprio contexto');
console.log('OK tab-switch');
await browser.close();
