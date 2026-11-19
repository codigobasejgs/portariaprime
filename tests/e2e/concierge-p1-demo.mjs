// P1 Portaria e Visitantes na /demonstracao (sem rede): porteiro registra entregador, ocorrência, vê histórico e
// portões/câmeras com estado honesto (botões de ação desabilitados); síndico vê indicadores e configura convites.
// Celular, tablet e desktop. Uso: APP=http://127.0.0.1:3017 node tests/e2e/concierge-p1-demo.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const browser = await chromium.launch({ channel: 'msedge' });
const VIEWS = [['celular', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1280, height: 860 }]];
const noOverflow = async (p, label) => assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: sem rolagem horizontal`);

for (const [label, viewport] of VIEWS) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return u.origin !== new URL(APP).origin || /^\/api(\/|$)/.test(u.pathname) ? r.abort() : r.continue(); });

  // Porteiro: entregador.
  await p.goto(`${APP}/c/demonstracao/visitantes?perfil=porteiro`);
  await p.getByRole('heading', { name: 'Visitantes' }).waitFor();
  await p.getByRole('button', { name: 'Entregador' }).click();
  let dlg = p.getByRole('dialog', { name: 'Registrar entrada' });
  await dlg.getByLabel('Unidade').selectOption({ index: 1 });
  await dlg.getByLabel('Nome', { exact: true }).fill('Marcos Entregador');
  await dlg.getByLabel('Quem autorizou').fill('Portaria');
  await dlg.getByRole('button', { name: 'Registrar entrada' }).click();
  await p.getByRole('dialog', { name: /Encomendas de Marcos Entregador/ }).waitFor();
  await p.keyboard.press('Escape');
  await p.getByText('Marcos Entregador').first().waitFor();
  await noOverflow(p, `${label}/agora`);

  // Ocorrência.
  await p.getByRole('tab', { name: 'Ocorrências' }).click();
  await p.getByRole('button', { name: 'Nova ocorrência' }).click();
  dlg = p.getByRole('dialog', { name: 'Nova ocorrência' });
  await dlg.getByLabel('Título').fill('Lâmpada queimada no hall');
  await dlg.getByRole('button', { name: 'Registrar' }).click();
  await p.getByText('Lâmpada queimada no hall').waitFor();
  await p.getByRole('button', { name: 'Encerrar' }).first().click();
  dlg = p.getByRole('dialog', { name: /Encerrar/ });
  await dlg.getByLabel('Como foi resolvida').fill('Trocada pelo zelador');
  await dlg.getByRole('button', { name: 'Encerrar' }).click();
  await p.getByText('Nenhuma ocorrência aberta.').waitFor();

  // Histórico unificado.
  await p.getByRole('tab', { name: 'Histórico' }).click();
  await p.getByRole('list', { name: 'Histórico de acessos' }).getByText('Marcos Entregador').first().waitFor();
  await noOverflow(p, `${label}/historico`);

  // Portões e câmeras: estado honesto, ação desabilitada.
  await p.getByRole('tab', { name: 'Portões e câmeras' }).click();
  await p.getByText('Portão social').waitFor();
  assert.ok(await p.getByText('Não instalado').first().isVisible());
  const gate = p.getByRole('listitem').filter({ hasText: 'Portão social' });
  assert.equal(await gate.getByRole('button', { name: 'Abrir', exact: true }).isDisabled(), true, 'abrir portão desabilitado nesta fase');
  assert.equal(await p.getByRole('listitem').filter({ hasText: 'Câmera da guarita' }).getByRole('button', { name: 'Ver ao vivo', exact: true }).isDisabled(), true);
  await noOverflow(p, `${label}/acessos`);
  assert.deepEqual(errors, []);
  await ctx.close();

  // Síndico: indicadores e configuração.
  const c2 = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const s = await c2.newPage();
  const e2 = [];
  s.on('pageerror', (e) => e2.push(e.message));
  await c2.route('**/*', (r) => { const u = new URL(r.request().url()); return u.origin !== new URL(APP).origin || /^\/api(\/|$)/.test(u.pathname) ? r.abort() : r.continue(); });
  await s.goto(`${APP}/c/demonstracao/painel?perfil=admin`);
  await s.getByText('Visitas (30 dias)').waitFor();
  await s.goto(`${APP}/c/demonstracao/configuracoes?m=visitantes`);
  await s.getByText('Visitantes e convites').waitFor();
  await s.getByLabel('Validade padrão (horas)').fill('6');
  await s.getByRole('button', { name: 'Salvar' }).click();
  await s.getByText('Configuração salva.').waitFor();
  await noOverflow(s, `${label}/config`);
  assert.deepEqual(e2, []);
  await c2.close();
  console.log(`ok   ${label}`);
}
await browser.close();
console.log('OK concierge-p1-demo');
