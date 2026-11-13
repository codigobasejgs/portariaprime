// UI anônima com dispositivo pareado; API simulada (Gemini e câmera física não homologados).
// Uso: APP=http://127.0.0.1:3017 node tests/e2e/device-ocr-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const app = process.env.APP || 'http://127.0.0.1:3017';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(app).hostname));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('pp_device:teste-ocr', 'a'.repeat(64)));
  let calls = 0;
  await context.route('**/api/totem/*', async route => {
    assert.equal(route.request().headers()['x-device-secret'], 'a'.repeat(64));
    assert.equal(route.request().headers().authorization, undefined);
    if (route.request().url().endsWith('/context')) return route.fulfill({ json: { units: [{ id: 'u1', block: 'A', label: '12B' }] } });
    if (route.request().url().endsWith('/receive')) {
      assert.equal(route.request().postDataJSON().unitId, 'u1');
      return route.fulfill({ json: { ok: true, replayed: false, storage_code: 'A2', storage_rack: 'Estante A', storage_shelf: '2', concierge_name: 'Principal' } });
    }
    assert.ok(route.request().url().endsWith('/ocr'));
    assert.match(route.request().postDataJSON().imageBase64, /^data:image\/jpeg;base64,/);
    calls++;
    return route.fulfill({ json: { carrier: 'Correios', trackingCode: 'BR123', block: 'A', unit: '12B', confidence: 90 } });
  });
  const page = await context.newPage();
  await page.goto(`${app}/c/teste-ocr/totem`);
  await page.getByRole('button', { name: 'Escanear etiqueta (câmera)' }).waitFor();
  assert.equal(await page.getByText(/Sou da equipe/).count(), 0);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 100;
    const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = 'black'; ctx.fillText('A 12B', 10, 40); return c.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByText('Etiqueta lida. Confira unidade, transportadora e rastreio antes de enviar.').waitFor();
  assert.equal(await page.getByLabel('Rastreio').inputValue(), 'BR123');
  assert.equal(await page.getByLabel('Unidade', { exact: true }).inputValue(), 'u1');
  assert.equal(calls, 1);
  assert.match(page.url(), /\/totem$/);
  await page.getByLabel('Nome do entregador (obrigatório)').fill('João - Correios');
  // Celular pequeno: o botão de registrar fica visível sem rolar até o fim do formulário.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await page.getByRole('button', { name: 'Registrar encomenda e avisar moradores' }).boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 640, `botão fora da tela: ${JSON.stringify(box)}`);
  await page.getByRole('button', { name: 'Registrar encomenda e avisar moradores' }).click();
  await page.getByText('Encomenda registrada e disponível para os moradores da unidade. Avisos colocados na fila de envio.').waitFor();
  await page.getByText(/Deposite a encomenda em: Principal · Estante A/).waitFor();
  assert.equal(await page.getByText(/Pré-registro recebido/).count(), 0);
  await page.getByRole('button', { name: 'Registrar outra encomenda' }).click();
  assert.equal(await page.getByLabel('Rastreio').inputValue(), '');
  console.log('PASS: OCR e recebimento direto sem login ou conferência posterior. API simulada.');
} finally { await browser.close(); }
