// Módulos Visitantes e Central na /demonstracao (sem rede): morador convida, portaria lê o convite e registra
// entrada manual com quem autorizou; Central mostra estado honesto (simulado, sem hardware). Celular, tablet, desktop.
// Uso: APP=http://127.0.0.1:3017 node tests/e2e/modules-demo.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
const VIEWS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1280, height: 860 }]];

async function page(viewport) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return u.origin !== new URL(APP).origin || /^\/api(\/|$)/.test(u.pathname) ? r.abort() : r.continue(); });
  return { ctx, p, errors };
}
const noOverflow = async (p, label) => assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: sem rolagem horizontal`);

for (const [label, viewport] of VIEWS) {
  // Morador: convite com QR de uso único.
  {
    const { ctx, p, errors } = await page(viewport);
    await p.goto(`${APP}/c/demonstracao/visitantes?perfil=morador`);
    await p.getByRole('heading', { name: 'Visitantes' }).waitFor();
    await p.getByRole('button', { name: 'Novo convite' }).click();
    const dlg = p.getByRole('dialog', { name: 'Novo convite' });
    await dlg.getByLabel('Nome do visitante').fill('Bruna Convidada');
    await dlg.getByRole('button', { name: 'Gerar convite' }).click();
    await p.getByRole('dialog', { name: 'Convite criado' }).getByText('Bruna Convidada').waitFor();
    await p.getByRole('dialog', { name: 'Convite criado' }).getByRole('button', { name: /Fechar/ }).click();
    await p.getByText('Bruna Convidada').first().waitFor();
    assert.ok(await p.getByRole('link', { name: 'Visitas' }).count(), 'item Visitas na navegação do morador');
    await noOverflow(p, `${label}/morador`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // Porteiro: central + entrada por convite + entrada manual + saída.
  {
    const { ctx, p, errors } = await page(viewport);
    await p.goto(`${APP}/c/demonstracao/central?perfil=porteiro`);
    await p.getByRole('heading', { name: 'Central da portaria' }).waitFor();
    await p.getByText('Simulado').first().waitFor();
    await p.getByText('Sem hardware homologado').waitFor();
    await noOverflow(p, `${label}/central`);
    await p.goto(`${APP}/c/demonstracao/visitantes?perfil=porteiro`);
    await p.getByRole('heading', { name: 'Visitantes' }).waitFor();
    await p.getByRole('button', { name: 'Ler convite (QR)' }).click();
    let dlg = p.getByRole('dialog', { name: 'Ler convite' });
    await dlg.getByLabel('Código do convite').fill(`PV1.${'d'.repeat(64)}`);
    await dlg.getByRole('button', { name: 'Conferir' }).click();
    await dlg.getByText('Paula Fictícia').waitFor();
    await dlg.getByRole('button', { name: 'Confirmar entrada' }).click();
    await p.getByRole('dialog', { name: 'Ler convite' }).waitFor({ state: 'detached' });
    await p.getByText('Paula Fictícia').first().waitFor();
    // Mesmo QR de novo: negado.
    await p.getByRole('button', { name: 'Ler convite (QR)' }).click();
    dlg = p.getByRole('dialog', { name: 'Ler convite' });
    await dlg.getByLabel('Código do convite').fill(`PV1.${'d'.repeat(64)}`);
    await dlg.getByRole('button', { name: 'Conferir' }).click();
    await dlg.getByText(/Convite usado/).waitFor();
    await p.keyboard.press('Escape');
    // Entrada manual exige quem autorizou.
    await p.getByRole('button', { name: 'Entrada sem convite' }).click();
    dlg = p.getByRole('dialog', { name: 'Registrar entrada' });
    await dlg.getByLabel('Unidade').selectOption({ index: 1 });
    await dlg.getByLabel('Nome', { exact: true }).fill('Roberto Prestador');
    await dlg.getByLabel('Quem autorizou').fill('Síndico');
    await dlg.getByRole('button', { name: 'Registrar entrada' }).click();
    await p.getByText('Roberto Prestador').first().waitFor();
    const before = await p.getByRole('button', { name: 'Registrar saída' }).count();
    await p.getByRole('button', { name: 'Registrar saída' }).first().click();
    await p.waitForFunction((n) => document.querySelectorAll('button').length && [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('Registrar saída')).length < n, before);
    await noOverflow(p, `${label}/visitantes`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(`ok   ${label}`);
}
await browser.close();
console.log('OK modules-demo');
