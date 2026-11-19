// Transportadoras com logo (/demonstracao): grade no recebimento, selo nas listas do porteiro e do morador.
// Capturas em tests/evidence/tmp/carriers-*.png. Uso: APP=http://127.0.0.1:3017 node tests/e2e/carriers-demo.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${APP}/c/demonstracao/portaria?perfil=porteiro`);
await page.getByRole('button', { name: 'Receber encomenda' }).click();
const dlg = page.getByRole('dialog', { name: 'Receber encomenda' });
await dlg.getByText('Ver todas as transportadoras').click();
const all = dlg.getByRole('group', { name: 'Todas as transportadoras' });
await all.getByRole('button', { name: 'Braspress' }).click();
assert.equal(await all.getByRole('button', { name: 'Braspress' }).getAttribute('aria-pressed'), 'true');
await dlg.getByText('Transportadora:').scrollIntoViewIfNeeded();
await page.screenshot({ path: 'tests/evidence/tmp/carriers-receber.png' });
await dlg.getByRole('button', { name: 'Fechar' }).first().click().catch(() => page.keyboard.press('Escape'));

await page.goto(`${APP}/c/demonstracao/portaria?perfil=porteiro`);
await page.getByText('Aguardando retirada').first().waitFor();
await page.locator('[data-tour="aguardando-lista"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: 'tests/evidence/tmp/carriers-portaria.png' });

await page.goto(`${APP}/c/demonstracao/inicio?perfil=morador`);
await page.getByRole('heading', { level: 1 }).waitFor();
await page.getByRole('button', { name: 'Mostrar QR de retirada' }).first().scrollIntoViewIfNeeded();
await page.mouse.wheel(0, -160);
await page.screenshot({ path: 'tests/evidence/tmp/carriers-morador.png' });

assert.deepEqual(errors, []);
await browser.close();
console.log('OK carriers-demo');
