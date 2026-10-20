// Verifica a interface real sem autenticação e sem mocks de API.
// Não envia formulários nem aciona integrações externas.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const output = 'tests/evidence';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [360, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:3017/entrar');
    await page.getByRole('heading', { name: 'Entrar', exact: true }).waitFor();
    await page.getByLabel('E-mail', { exact: true }).fill('interface@example.invalid');
    await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
    await page.getByRole('heading', { name: 'Recuperar senha' }).waitFor();
    await page.getByRole('link', { name: 'Voltar para entrar' }).click();
    await page.getByRole('heading', { name: 'Entrar', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Rolagem horizontal em ${width}px`);
    assert.deepEqual(errors, [], `Erros JavaScript em ${width}px`);
    await page.screenshot({ path: `${output}/login-${width}.png`, fullPage: true });
    await page.close();
    console.log(`PASS interface login/recuperação ${width}px`);
  }
} finally { await browser.close(); }
