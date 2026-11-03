// Experiência do administrador no NAVEGADOR REAL contra Supabase REAL local (dados sintéticos).
// Navegação lateral, Visão geral (Operação/Análise com agregações do banco), sino com
// contagem por usuário, Relatórios, Configurações por módulo (URL direta), Unidades e
// moradores em abas, rotas antigas e matriz de larguras 320–1920 sem rolagem horizontal.
// Capturas em tests/evidence/admin-*.png (fora do Git; só dados fictícios).
//
// PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 SUPABASE_URL=... SUPABASE_ANON_KEY=... \
//   SUPABASE_SERVICE_ROLE_KEY=... node tests/e2e/admin-ux.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !anon || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase.');
assertLocalSupabase(url);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(url, secret, opts);
const run = `e2e${Date.now().toString(36)}`;
const slug = `${run}-admin`;
const evidence = 'tests/evidence';
await mkdir(evidence, { recursive: true });
const step = (s) => console.log(`- ${s}`);

async function account(key, name) {
  const email = `${run}-${key}@e2e.portariaprime.invalid`;
  const password = `S${crypto.randomUUID()}!`;
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  const client = createClient(url, anon, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { email, password, id: data.user.id, client };
}
const call = async (who, fn, args) => {
  const { data, error } = await who.client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};

await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  step('fixtures: condomínio, 2 unidades, estante, 3 encomendas (1 antiga), notificações');
  const sindico = await account('sindico', 'Síndica Teste');
  const porteiro = await account('porteiro', 'Porteiro Teste');
  const { tenant_id: T } = await call(sindico, 'provision_tenant', {
    p_request_id: crypto.randomUUID(), p_name: 'E2E Admin', p_slug: slug, p_document: String(Date.now()).padStart(14, '2').slice(-14),
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly', p_contact_phone: null,
  });
  const ins = async (table, row) => { const { data, error } = await sindico.client.from(table).insert(row).select('id').single(); if (error) throw error; return data.id; };
  const u1 = await ins('units', { tenant_id: T, block: 'A', label: '101' });
  await ins('units', { tenant_id: T, block: 'A', label: '102' });
  const { data: conc } = await sindico.client.from('concierge_locations').select('id').eq('tenant_id', T).single();
  const loc = await ins('storage_locations', { tenant_id: T, concierge_location_id: conc.id, code: 'A-1', rack: 'Estante A', shelf: 'Prateleira 1', capacity: 4 });
  const inv = await call(sindico, 'create_invitation', { p_tenant: T, p_email: porteiro.email, p_role: 'porteiro', p_unit: null, p_permissions: [] });
  await call(porteiro, 'accept_invitation', { p_token: inv.token });
  const now = Date.now();
  const pk = (h, carrier) => ({ tenant_id: T, unit_id: u1, status: 'ARMAZENADA', carrier, idempotency_key: crypto.randomUUID(),
    received_at: new Date(now - h * 3600_000).toISOString(), storage_location_id: loc });
  const { error: pe } = await svc.from('packages').insert([pk(1, 'Correios'), pk(5, 'Shopee'), pk(80, 'Correios')]);
  if (pe) throw pe;
  const op = await call(sindico, 'dashboard_operation', { p_tenant: T });
  assert.equal(op.waiting_now, 3); assert.equal(op.stale_now, 1);
  const { error: ne } = await svc.from('notifications').insert([
    { tenant_id: T, user_id: sindico.id, kind: 'ops_alert', title: 'Teste de aviso A', body: 'corpo A' },
    { tenant_id: T, user_id: sindico.id, kind: 'trial_reminder', title: 'Teste de aviso B', body: 'corpo B' },
    { tenant_id: T, user_id: porteiro.id, kind: 'ops_alert', title: 'Só do porteiro', body: 'x' },
  ]);
  if (ne) throw ne;

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${APP}/entrar?next=${encodeURIComponent(`/c/${slug}`)}`);
  await page.getByLabel('E-mail', { exact: true }).fill(sindico.email);
  await page.getByLabel('Senha', { exact: true }).fill(sindico.password);
  await page.getByRole('button', { name: 'Entrar' }).click();

  step('admin entra na Visão geral; menu na ordem pedida; sem faixa de mês grátis');
  await page.waitForURL(/\/painel$/);
  await page.getByRole('heading', { name: 'Visão geral' }).waitFor();
  const nav = await page.getByRole('navigation', { name: 'Principal' }).getByRole('link').allInnerTexts();
  assert.deepEqual(nav.map((s) => s.trim()), ['Visão geral', 'Encomendas', 'Unidades e moradores', 'Relatórios']);
  assert.equal(await page.getByText(/Mês grátis até/).count(), 0, 'faixa de teste removida do topo');
  await page.getByText('Aguardando retirada agora').waitFor();
  await page.getByText(`Encomendas aguardando há mais de 72 h`).waitFor();
  assert.match(await page.getByText(/de 4 vagas/).innerText(), /3 de 4 vagas/);
  await page.screenshot({ path: `${evidence}/admin-operacao-1280.png`, fullPage: true });

  step('sino: 2 não lidas só do próprio usuário; marcar uma; destino do lembrete do teste');
  const bell = page.getByRole('button', { name: /Notificações/ });
  assert.equal(await bell.getAttribute('aria-label'), 'Notificações, 2 não lidas');
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Notificações' });
  assert.equal(await panel.getByText('Só do porteiro').count(), 0);
  await panel.getByText('Teste de aviso B').click();
  await page.waitForURL(/configuracoes\?m=plano/);
  await page.getByRole('button', { name: 'Notificações, 1 não lidas' }).waitFor();
  const { data: pn } = await svc.from('notifications').select('read_at').eq('user_id', porteiro.id).single();
  assert.equal(pn.read_at, null, 'leitura não afeta outro usuário');

  // Aba Análise = dashboard executivo (d3a4fca); números detalhados em tests/e2e/dashboard-executive.mjs.
  step('Análise: período, comparação sem base, mapa de calor com alternativa em tabela');
  await page.goto(`${APP}/c/${slug}/painel`);
  await page.getByRole('tab', { name: 'Análise' }).click();
  await page.getByText('Recebidas no período', { exact: true }).waitFor();
  await page.getByLabel('Período').selectOption('7');
  await page.getByText('Aguardando agora, por tempo').waitFor();
  await page.getByText('Quando as encomendas chegam').waitFor();
  await page.screenshot({ path: `${evidence}/admin-analise-1280.png`, fullPage: true });
  await page.reload();
  await page.getByText('Recebidas no período', { exact: true }).waitFor(); // aba lembrada
  assert.equal(await page.getByLabel('Período').inputValue(), '7', 'período lembrado após recarregar');

  step('KPI leva a Relatórios filtrado; exportação CSV');
  await page.getByRole('tab', { name: 'Operação' }).click();
  await page.getByRole('link', { name: /Acima de 72 h/ }).click();
  await page.waitForURL(/relatorios\?status=PENDENTES&antigas=1/);
  await page.getByRole('heading', { name: 'Relatórios' }).waitFor();
  await page.locator('tbody tr').first().waitFor();
  assert.equal(await page.locator('tbody tr').count(), 1, 'só a encomenda acima de 72 h');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar CSV' }).click()]);
  assert.match(dl.suggestedFilename(), /^encomendas-.*\.csv$/);

  step('Configurações: índice e módulo por URL direta; rota antiga de assinatura redireciona');
  await page.goto(`${APP}/c/${slug}/configuracoes`);
  for (const m of ['Condomínio', 'Identidade visual', 'Equipe e permissões', 'Plano e assinatura']) await page.getByText(m, { exact: true }).first().waitFor();
  await page.goto(`${APP}/c/${slug}/configuracoes?m=equipe`);
  await page.getByText(porteiro.email).waitFor();
  await page.goto(`${APP}/c/${slug}/assinatura`);
  await page.waitForURL(/configuracoes\?m=plano/);

  step('Unidades e moradores em abas; Encomendas com atalho do totem');
  await page.goto(`${APP}/c/${slug}/pessoas?aba=moradores`);
  await page.getByRole('tab', { name: /Moradores/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: /Moradores/ }).getAttribute('aria-selected'), 'true');
  await page.goto(`${APP}/c/${slug}/portaria`);
  await page.getByRole('heading', { name: 'Encomendas' }).waitFor();
  await page.getByRole('button', { name: 'Abrir totem' }).click();
  await page.waitForURL(/totem-equipe/);

  step('menu da conta: sem administração da plataforma para síndico comum');
  await page.getByRole('button', { name: 'Conta' }).click();
  await page.getByRole('menuitem', { name: 'Meu aplicativo e notificações' }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: /Administração da plataforma/ }).count(), 0);
  await page.keyboard.press('Escape');

  step('larguras 320–1920 sem rolagem horizontal; drawer no celular');
  for (const w of [320, 375, 414, 768, 1024, 1366, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const path of ['painel', 'relatorios', 'configuracoes', 'pessoas', 'portaria']) {
      await page.goto(`${APP}/c/${slug}/${path}`);
      await page.locator('main h1').first().waitFor();
      await page.waitForTimeout(150);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `rolagem horizontal em ${path} @${w}px (${over}px)`);
    }
    if (w === 375 || w === 1920) await page.goto(`${APP}/c/${slug}/painel`).then(() => page.getByText('Aguardando retirada agora').waitFor())
      .then(() => page.screenshot({ path: `${evidence}/admin-operacao-${w}.png`, fullPage: true }));
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Relatórios' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Menu' }).count(), 0);

  assert.deepEqual(errors, [], 'sem erros de página');
  console.log('OK admin-ux');
} finally {
  await browser.close();
}
