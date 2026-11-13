// Preenchimento por toque no recebimento (/demonstracao, sem rede):
// entregador recente, transportadora (inclusive nova, lembrada na próxima), porteiro, morador da unidade e tipo de volume.
// Uso: APP=http://127.0.0.1:3017 node tests/e2e/portaria-suggestions.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const dlg = () => page.getByRole('dialog', { name: 'Receber encomenda' });
const open = async () => {
  await page.getByRole('button', { name: 'Receber encomenda' }).click();
  await dlg().getByText('Etapa 1 de 3').waitFor();
};

await page.goto(`${APP}/c/demonstracao/portaria?perfil=porteiro`);
await open();

// Entregador já usado: um toque preenche o nome.
const couriers = dlg().getByRole('group', { name: 'Entregadores recentes' });
await couriers.getByRole('button').first().waitFor({ timeout: 15000 });
const courierName = await couriers.getByRole('button').first().innerText();
await couriers.getByRole('button').first().click();
assert.equal(await dlg().getByLabel('Nome do entregador (obrigatório)').inputValue(), courierName);

// Porteiro: vem preenchido com quem está logado.
assert.ok((await dlg().getByLabel('Recebido por (porteiro, obrigatório)').inputValue()).length >= 2, 'porteiro logado preenchido');

// Transportadora nova digitada: segue para a etapa 2 e vira sugestão na próxima vez.
await dlg().getByRole('button', { name: 'Digitar outra transportadora' }).click();
await dlg().getByLabel('Transportadora', { exact: true }).fill('Jadlog Teste');
await dlg().getByRole('button', { name: 'Avançar', exact: true }).click();
await dlg().getByText('Etapa 2 de 3').waitFor();

// Unidade → moradores para tocar → destinatário preenchido.
await dlg().getByPlaceholder('Buscar unidade').fill('A 101');
await dlg().getByRole('option', { name: 'Bloco A · 101' }).click();
const resident = dlg().getByLabel('Moradores da unidade').getByRole('button', { name: /João Silva/ });
await resident.click();
assert.equal(await dlg().getByLabel('Destinatário (como está na etiqueta)').inputValue(), 'João Silva');

// Tipo de volume por toque.
await dlg().getByRole('group', { name: 'Tipos de volume' }).getByRole('button', { name: 'Envelope' }).click();
assert.equal(await dlg().getByLabel('Tipo de volume (opcional)').inputValue(), 'Envelope');

await dlg().getByText('Guardei fisicamente em').click();
await dlg().getByRole('button', { name: 'Salvar e avançar' }).click();
await dlg().getByText(/Envelope/).first().waitFor({ timeout: 10000 });
await dlg().getByRole('button', { name: 'Encerrar recebimento' }).click();
await dlg().getByRole('button', { name: 'Finalizar' }).click();

// Próximo recebimento: a transportadora nova aparece entre as frequentes.
await open();
await dlg().getByRole('group', { name: 'Transportadoras frequentes' }).getByRole('button', { name: 'Jadlog Teste' }).waitFor();

assert.deepEqual(errors, [], 'sem erros de página');
console.log('OK portaria-suggestions');
await browser.close();
