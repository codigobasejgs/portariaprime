// Botão/passo a passo de instalar o app no Início do morador (/demonstracao): iPhone mostra os 3 passos do Safari,
// Android mostra o botão do sistema quando o navegador oferece (aqui simulado com beforeinstallprompt), "Agora não"
// esconde neste aparelho. Salva capturas em tests/evidence/tmp/install-*.png. Uso: APP=http://127.0.0.1:3017 node ...
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

async function open(ua, { prompt = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: ua, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return u.origin !== new URL(APP).origin || /^\/api(\/|$)/.test(u.pathname) ? r.abort() : r.continue(); });
  if (prompt) {
    // Como o Chrome do Android faz quando o site é instalável: dispara beforeinstallprompt.
    await p.addInitScript(() => {
      window.__installed = false;
      addEventListener('load', () => setTimeout(() => {
        const e = new Event('beforeinstallprompt');
        e.prompt = async () => { window.__installed = true; };
        e.userChoice = Promise.resolve({ outcome: 'accepted' });
        dispatchEvent(e);
      }, 300));
    });
  }
  await p.goto(`${APP}/c/demonstracao/inicio?perfil=morador`);
  await p.getByText('Acompanhe pelo app').waitFor();
  return { ctx, p, errors };
}

// iPhone: passo a passo, sem botão de instalar (a Apple não permite).
{
  const { ctx, p, errors } = await open(IOS);
  const box = p.getByTestId('install-app');
  await box.getByRole('list', { name: 'Passo a passo para instalar no iPhone' }).waitFor();
  assert.equal(await box.getByRole('listitem').count(), 3);
  assert.ok(await box.getByText('Adicionar à Tela de Início').isVisible());
  assert.equal(await box.getByRole('button', { name: 'Instalar aplicativo' }).count(), 0);
  await box.scrollIntoViewIfNeeded();
  await p.screenshot({ path: 'tests/evidence/tmp/install-iphone.png', fullPage: false });
  // "Agora não" esconde e lembra neste aparelho.
  await p.getByRole('button', { name: 'Agora não' }).click();
  assert.equal(await p.getByText('Acompanhe pelo app').count(), 0);
  await p.reload();
  await p.getByRole('heading', { level: 1 }).waitFor();
  assert.equal(await p.getByText('Acompanhe pelo app').count(), 0, 'continua escondido após recarregar');
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('ok   iPhone: passo a passo');
}
// Android com o navegador oferecendo instalação: botão abre o instalador do sistema.
{
  const { ctx, p, errors } = await open(ANDROID, { prompt: true });
  const btn = p.getByTestId('install-app').getByRole('button', { name: 'Instalar aplicativo' });
  await btn.waitFor();
  await btn.scrollIntoViewIfNeeded();
  await p.screenshot({ path: 'tests/evidence/tmp/install-android.png', fullPage: false });
  await btn.click();
  assert.equal(await p.evaluate(() => window.__installed), true, 'abriu o instalador do sistema');
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('ok   Android: botão de instalar');
}
// Android sem a oferta do navegador: instrução pelo menu (⋮).
{
  const { ctx, p } = await open(ANDROID);
  await p.getByTestId('install-app').getByText('Instalar app').waitFor();
  await ctx.close();
  console.log('ok   Android: instrução pelo menu');
}
await browser.close();
console.log('OK install-app-demo');
