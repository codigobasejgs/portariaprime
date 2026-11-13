// Celular (360x640, o menor comum): em cada etapa do recebimento e da entrega o botão de ação fica
// visível sem rolar a página. Roda na /demonstracao (sem rede). Uso: APP=http://127.0.0.1:3017 node tests/e2e/portaria-steps-mobile.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const C = `${APP}/c/demonstracao`;
const out = 'tests/evidence';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// O botão precisa estar inteiro dentro da tela, sem depender de rolagem.
async function fixed(name, shot) {
  const b = page.getByRole('dialog').last().getByRole('button', { name, exact: true });
  await b.waitFor({ timeout: 15000 });
  const box = await b.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 640, `"${name}" fora da tela: ${JSON.stringify(box)}`);
  assert.ok(box.height >= 44, `"${name}" menor que 44px`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'sem rolagem horizontal');
  await page.screenshot({ path: `${out}/steps-${shot}.png` });
  return b;
}

await page.goto(`${C}/portaria?perfil=porteiro`);
await page.getByRole('button', { name: 'Receber encomenda' }).waitFor({ timeout: 20000 });
await page.screenshot({ path: `${out}/steps-0-inicio.png` });
await page.getByRole('button', { name: 'Receber encomenda' }).click();
await page.getByLabel('Nome do entregador (obrigatório)').fill('Marcos - Correios');
await (await fixed('Avançar', '1-entregador')).click();
await page.getByPlaceholder('Buscar unidade').fill('A 101');
await page.getByRole('option', { name: 'Bloco A · 101' }).click();
const save = await fixed('Salvar e avançar', '2-encomenda');
// Sem confirmar a guarda: o erro aparece junto do botão, não escondido no fim da página.
await save.click();
const err = page.getByText('Escolha o local e confirme');
await err.waitFor();
const eb = await err.boundingBox();
assert.ok(eb.y + eb.height <= 640, 'erro visível sem rolar');
await page.getByText('Guardei fisicamente em').click();
await save.click();
await fixed('Cadastrar próxima encomenda', '3-confirmacao');
await (await fixed('Encerrar recebimento', '3-confirmacao')).click();
await (await fixed('Finalizar', '4-resumo')).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });

await page.getByRole('button', { name: 'Entregar ao morador' }).click();
await fixed('Avançar', '5-entrega-unidade');
await page.getByRole('listbox', { name: 'Unidades com encomenda' }).getByRole('option', { name: /Bloco A · 101/ }).click();
await page.getByRole('button', { name: 'João Silva' }).click();
await (await fixed('Avançar', '6-entrega-quem')).click();
const boxes = page.getByRole('dialog').getByRole('checkbox');
assert.ok(await boxes.count() >= 2, 'unidade com várias encomendas para escolher');
await boxes.nth(0).check(); await boxes.nth(1).check();
await page.getByLabel('Justificativa').fill('Teste: morador sem celular, documento conferido');
await (await fixed('Avançar', '7-entrega-encomendas')).click();
for (let i = 0; i < 2; i++) {
  const confirm = await fixed('Confirmar entrega', `8-entrega-confirmar-${i + 1}`);
  await page.getByRole('button', { name: 'Usar foto de exemplo' }).click();
  await page.getByAltText('Foto do item entregue').waitFor();
  if (i === 0) {
    const canvas = page.getByRole('dialog').locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const b = await canvas.boundingBox();
    await page.mouse.move(b.x + 20, b.y + 30); await page.mouse.down();
    await page.mouse.move(b.x + 120, b.y + 70, { steps: 8 }); await page.mouse.move(b.x + 220, b.y + 30, { steps: 8 }); await page.mouse.up();
  }
  await confirm.click();
}
await (await fixed('Encerrar entrega', '9-entrega-resumo')).click();
assert.equal(await page.getByRole('list', { name: 'Encomendas entregues' }).count(), 0);
assert.deepEqual(errors, [], 'sem erros de página');
console.log('OK portaria-steps-mobile');
await browser.close();
