// Quiosque × portal público no NAVEGADOR REAL, sem login e sem criar dados (pode rodar contra o build local).
// WebView do app Android (user agent PortariaPrimeKiosk/x): portal e cadastro do morador nunca aparecem;
// vai direto ao login da equipe e volta para a portaria. Navegador comum: portal só do morador.
//   APP=http://127.0.0.1:4173 SLUG=<slug-existente> node tests/e2e/kiosk-routing.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const { APP, SLUG: slug, PROXY } = process.env;
if (!APP || !slug) throw new Error('Defina APP e SLUG.');
const browser = await chromium.launch(PROXY ? { proxy: { server: PROXY } } : {});
const errors = [];
try {
  const kioskUA = 'Mozilla/5.0 (Linux; Android 16; SM-A075M Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 PortariaPrimeKiosk/1.0.2';
  const k = await (await browser.newContext({ userAgent: kioskUA, viewport: { width: 390, height: 844 }, isMobile: true, ignoreHTTPSErrors: true })).newPage();
  k.on('pageerror', (e) => errors.push(`quiosque: ${e.message}`));
  for (const area of ['portaria', '', 'inicio', 'solicitar']) {
    await k.goto(`${APP}/c/${slug}${area ? `/${area}` : ''}`);
    await k.getByRole('heading', { name: 'Entrar na portaria' }).waitFor({ timeout: 30000 });
    const next = new URL(k.url()).searchParams.get('next');
    assert.equal(next, `/c/${slug}/portaria`, `quiosque /${area} → login da equipe com volta à portaria (veio ${next})`);
    assert.equal(await k.getByText(/Criar minha conta|Mora aqui e não tem conta|Cadastrar meu condomínio/).count(), 0, 'sem cadastro no quiosque');
    assert.equal(await k.getByRole('heading', { name: /portal dos moradores/ }).count(), 0);
  }
  await k.goto(`${APP}/cadastro?next=${encodeURIComponent(`/c/${slug}/solicitar`)}&portal=${slug}`);
  await k.getByRole('heading', { name: 'Entrar na portaria' }).waitFor();
  assert.equal(await k.getByLabel('Celular / WhatsApp').count(), 0, 'cadastro do morador bloqueado no quiosque');
  await k.screenshot({ path: 'tests/evidence/quiosque-login-390.png', fullPage: true });

  const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, ignoreHTTPSErrors: true })).newPage();
  p.on('pageerror', (e) => errors.push(`portal: ${e.message}`));
  await p.goto(`${APP}/c/${slug}`);
  await p.getByRole('heading', { name: 'Bem-vindo(a) ao portal dos moradores' }).waitFor({ timeout: 30000 });
  assert.ok(await p.getByRole('button', { name: 'Criar minha conta' }).isVisible());
  assert.equal(await p.getByRole('button', { name: /Portaria|Administração|Totem/ }).count(), 0, 'portal público só do morador');
  await p.goto(`${APP}/c/${slug}/portaria`);
  await p.waitForURL((u) => !/\/portaria$/.test(u.pathname));
  assert.deepEqual(errors, [], errors.join(' | '));
  console.log('OK kiosk-routing');
} finally { await browser.close(); }
