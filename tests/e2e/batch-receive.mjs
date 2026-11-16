// Recebimento em lote (/demonstracao, sem rede): 6 etiquetas de uma vez; as que conferem são registradas sozinhas,
// as outras vão para o relatório de pendências; uma é resolvida escolhendo a unidade. Celular 390x844.
// Uso: APP=http://127.0.0.1:3017 node tests/e2e/batch-receive.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const external = [];
await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.origin !== new URL(APP).origin || /^\/api(\/|$)/.test(u.pathname)) { external.push(u.href); return r.abort(); } return r.continue(); });

const kpi = async () => {
  await page.goto(`${APP}/c/demonstracao/painel?perfil=admin`);
  const card = page.locator('a', { hasText: 'Aguardando retirada agora' });
  await card.waitFor({ timeout: 15000 });
  return Number((await card.locator('p').nth(1).innerText()).replace(/\D/g, ''));
};
const before = await kpi();

await page.goto(`${APP}/c/demonstracao/portaria?perfil=porteiro`);
await page.getByRole('button', { name: 'Receber várias de uma vez (fotos)' }).click();
const dlg = page.getByRole('dialog', { name: 'Receber várias encomendas' });
await dlg.waitFor();
// Porteiro logado já vem preenchido; entregador por toque nos recentes.
assert.ok((await dlg.getByLabel('Recebido por (porteiro)').inputValue()).length >= 2, 'porteiro logado preenchido');
assert.ok(await page.getByRole('button', { name: 'Enviar 0 encomenda(s)' }).isDisabled(), 'sem fotos não envia');
await dlg.getByRole('button', { name: 'Usar 6 etiquetas de exemplo' }).click();
await page.getByRole('button', { name: 'Enviar 6 encomenda(s)' }).click();
await page.getByText('Informe o nome do entregador.').waitFor();
await dlg.getByLabel('Entregador (obrigatório)').fill('Marcos - Correios');
await dlg.getByRole('list', { name: 'Etiquetas do lote' }).getByRole('listitem').nth(5).waitFor();
assert.equal(await dlg.getByRole('list', { name: 'Etiquetas do lote' }).getByRole('listitem').count(), 6);
// Botão de enviar sempre visível embaixo, sem rolar.
const box = await page.getByRole('button', { name: 'Enviar 6 encomenda(s)' }).boundingBox();
assert.ok(box && box.y + box.height <= 844, 'enviar visível');
await page.getByRole('button', { name: 'Enviar 6 encomenda(s)' }).click();

// Relatório: registradas x pendências.
await dlg.getByText('Relatório do lote').waitFor({ timeout: 30000 });
const ok = Number(await dlg.getByText('Registradas e moradores avisados').locator('xpath=following-sibling::p').innerText());
const pend = Number(await dlg.getByText('Precisam de você').locator('xpath=following-sibling::p').innerText());
assert.equal(ok + pend, 6, `todas processadas (${ok} + ${pend})`);
assert.ok(ok >= 3 && pend >= 1, `deve haver registradas e pendências (${ok}/${pend})`);
await dlg.getByRole('region', { name: 'Pendências do lote' }).or(dlg.locator('section[aria-label="Pendências do lote"]')).first().waitFor();

// Resolver uma pendência: escolhe a unidade e um morador por toque.
await dlg.getByRole('button', { name: 'Resolver' }).first().click();
const fix = page.getByRole('dialog', { name: 'Resolver pendência' });
await fix.getByPlaceholder('Buscar unidade').fill('B 102');
await fix.getByRole('listbox', { name: 'Unidades encontradas' }).getByRole('option').first().click();
await fix.getByRole('group', { name: 'Moradores da unidade' }).getByRole('button').first().click();
await fix.getByRole('button', { name: 'Registrar' }).click();
await fix.waitFor({ state: 'detached', timeout: 10000 });
assert.equal(Number(await dlg.getByText('Registradas e moradores avisados').locator('xpath=following-sibling::p').innerText()), ok + 1);
await page.getByRole('button', { name: 'Concluir' }).click();

// Painel do síndico: aguardando retirada subiu exatamente o número registrado.
assert.equal(await kpi(), before + ok + 1);
assert.deepEqual(errors, [], 'sem erros de página');
assert.deepEqual(external, [], 'sem requisições externas ou /api');
console.log(`OK batch-receive (${ok} automáticas, ${pend} pendências, 1 resolvida)`);
await browser.close();
