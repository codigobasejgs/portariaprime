// Simulador do Portaria Prime IA (/demonstracao, sem rede): pendências, relatório 6 meses, níveis e Resumo -> Confirmar.
// Landing com a seção do assistente. Uso: APP=http://127.0.0.1:3017 node tests/e2e/assistant-demo.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const external = [];
await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.origin !== new URL(APP).origin) { external.push(u.href); return r.abort(); } return r.continue(); });

// Landing: seção e atalho para a demonstração.
await page.goto(APP);
const sec = page.locator('#assistente');
await sec.getByRole('heading', { name: 'Seu assistente direto no WhatsApp.' }).waitFor({ timeout: 20000 });
assert.equal(await sec.locator('li').count(), 5, '5 passos');
await sec.getByRole('link', { name: 'Testar o assistente na demonstração' }).click();
// A landing busca o catálogo de planos (fora da demonstração); daqui em diante, nada pode sair do navegador.
external.length = 0;

// Simulador.
const chat = page.getByRole('region', { name: 'Simulador do Portaria Prime IA no WhatsApp' });
await chat.waitFor({ timeout: 20000 });
await chat.getByText(/Portaria Prime IA · Jardins Prime/).waitFor();
const last = () => chat.locator('.bg-white.rounded-xl, .rounded-xl.bg-white').last();

await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Listar pendências de hoje' }).click();
await chat.getByText(/📋 Pendências de hoje/).last().waitFor();
assert.match(await last().innerText(), /Aguardando retirada: \d+/);

await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Analisar últimos 6 meses' }).click();
await chat.getByText(/Relatório · Últimos 6 meses/).last().waitFor();
assert.match(await last().innerText(), /Transportadoras:/);

// Intermediário: aprovar cadastro mostra RESUMO; Cancelar não grava, Confirmar grava.
await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Cadastros pendentes' }).click();
await chat.getByText(/Cadastros pendentes \(\d+\)/).last().waitFor();
const before = Number((await last().innerText()).match(/Cadastros pendentes \((\d+)\)/)[1]);
await last().getByRole('button').first().click();
await chat.getByText(/Confira antes de confirmar/).last().waitFor();
await last().getByRole('button', { name: '❌ Cancelar' }).click();
await chat.getByText(/Nada foi alterado/).last().waitFor();
await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Cadastros pendentes' }).click();
await chat.getByText(new RegExp(`Cadastros pendentes \\(${before}\\)`)).last().waitFor();
await last().getByRole('button').first().click();
await chat.getByText(/Confira antes de confirmar/).last().waitFor();
// Sem botões: '1' solto NÃO confirma; só o código desta proposta (CONFIRMAR XXXX).
const code = (await last().innerText()).match(/CONFIRMAR ([0-9A-F]{4})/)[1];
await chat.getByLabel('Mensagem').fill('1');
await chat.getByRole('button', { name: 'Enviar' }).click();
await chat.getByText(/Não entendi/).last().waitFor();
assert.equal(await chat.getByText(/Cadastro aprovado/).count(), 0, '"1" não confirmou');
await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Cadastros pendentes' }).click();
await last().getByRole('button').first().click();
await chat.getByText(/Confira antes de confirmar/).last().waitFor();
const code2 = (await last().innerText()).match(/CONFIRMAR ([0-9A-F]{4})/)[1];
void code;
await chat.getByLabel('Mensagem').fill(`confirmar ${code2}`);
await chat.getByRole('button', { name: 'Enviar' }).click();
await chat.getByText(/Cadastro aprovado/).last().waitFor();

// Foto exige nível Avançado.
await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Foto de etiqueta' }).click();
await chat.getByText(/exigem o nível Avançado/).last().waitFor();
await chat.getByLabel('Nível').selectOption('advanced');
await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Foto de etiqueta' }).click();
await chat.getByText(/registrar encomenda \(foto da etiqueta\)/).last().waitFor();
await last().getByRole('button', { name: '✅ Confirmar' }).click();
await chat.getByText(/Encomenda registrada/).last().waitFor();

// Básico: ações bloqueadas.
await chat.getByLabel('Nível').selectOption('basic');
await chat.getByRole('group', { name: 'Exemplos rápidos' }).getByRole('button', { name: 'Cadastros pendentes' }).click();
const txt = await chat.getByText(/Cadastros pendentes/).last().innerText().catch(() => '');
assert.doesNotMatch(await last().innerText(), /Toque para aprovar/, 'básico não oferece aprovar');
void txt;

// Painel: número autorizado e níveis visíveis.
await page.getByRole('list', { name: 'Números autorizados' }).waitFor();
await page.getByText('Nível 3 · Avançado').waitFor();

assert.deepEqual(errors, [], 'sem erros de página');
assert.deepEqual(external, [], 'sem requisições externas');
const doc = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(doc <= 0, `sem rolagem horizontal (${doc}px)`);
console.log('OK assistant-demo');
await browser.close();
