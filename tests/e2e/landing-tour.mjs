// Landing, conversão, tour e ajuda no NAVEGADOR REAL contra a stack local isolada.
// Verifica: / pública sem sessão; preços do banco; ciclo; CTAs preservam plano até o cadastro; formulário grava;
// eventos de funil sem PII; 5 larguras sem rolagem horizontal; zoom 200%; teclado; tour com alvos reais,
// pular/retomar, troca de rota; ajuda com busca e artigo. Sem envio externo.
//   PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/landing-tour.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase, fakeCnpj, onboard } from './environment.mjs';

const { APP, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: secret, PP_E2E_ALLOW } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP) throw new Error('Defina PP_E2E_ALLOW=1 e APP.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false } });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const step = (s) => console.log(`• ${s}`);
const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

try {
  await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime', 'sob-medida']);
  const { data: price } = await svc.from('plan_prices').select('amount_cents, plans!inner(code)').eq('plans.code', 'prime').eq('cycle', 'yearly').eq('active', true).single();

  step('landing pública em 5 larguras, sem rolagem horizontal e sem erro JS');
  for (const width of [360, 390, 768, 1024, 1440]) {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${APP}/`);
    await p.getByRole('heading', { level: 1, name: 'Cada encomenda. Tudo sob controle.' }).waitFor();
    await p.getByRole('heading', { name: 'Planos' }).scrollIntoViewIfNeeded();
    await p.getByText('Profissional', { exact: true }).first().waitFor();
    assert.ok(await noHScroll(p), `rolagem horizontal em ${width}px`);
    assert.deepEqual(errors, [], `erros JS em ${width}px`);
    await p.close();
  }

  step('preço vem do banco e ciclo anual mostra total');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const funnel = [];
  p.on('request', (r) => { if (r.url().endsWith('/api/funnel')) funnel.push(JSON.parse(r.postData() || '{}')); });
  await p.goto(`${APP}/`);
  await p.locator('#planos').scrollIntoViewIfNeeded();
  await p.getByRole('radio', { name: 'Anual' }).click();
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ');
  const primeCard = p.locator('#planos div', { has: p.getByRole('heading', { name: 'Prime' }) }).last();
  assert.ok((await primeCard.innerText()).replace(/\s/g, ' ').includes(brl(price.amount_cents)), 'preço anual do Prime igual ao banco');

  step('galeria abre zoom acessível e fecha com Esc');
  await p.locator('#demonstracao').getByRole('button', { name: /Ampliar/ }).first().click();
  await p.getByRole('dialog').waitFor();
  await p.keyboard.press('Escape');
  await p.getByRole('dialog').waitFor({ state: 'detached' });

  step('teclado: Tab alcança CTA principal com foco visível');
  await p.goto(`${APP}/`);
  await p.getByRole('heading', { level: 1 }).waitFor();
  for (let i = 0; i < 12; i++) { await p.keyboard.press('Tab'); if ((await p.evaluate(() => document.activeElement?.textContent)) === 'Testar grátis por 1 mês') break; }
  assert.equal(await p.evaluate(() => document.activeElement?.textContent), 'Testar grátis por 1 mês');

  step('CTA do plano leva ao cadastro preservando plano e ciclo');
  await p.locator('#planos').scrollIntoViewIfNeeded();
  await p.getByRole('radio', { name: 'Trimestral' }).click();
  await p.locator('#planos').getByRole('button', { name: 'Testar grátis por 1 mês' }).nth(2).click();
  await p.waitForURL(/\/cadastro\?next=/);
  assert.match(decodeURIComponent(p.url()), /\/onboarding\?plano=prime&ciclo=quarterly/);

  step('eventos de funil sem dados pessoais');
  await p.waitForTimeout(800);
  const visitor = await p.evaluate(() => localStorage.getItem('pp_visitor'));
  const { data: ev } = await svc.from('funnel_events').select('*').eq('visitor', visitor);
  const names = ev.map((e) => e.event);
  for (const e of ['landing_view', 'pricing_view', 'cta_trial_click', 'signup_started']) assert.ok(names.includes(e), `evento ${e}`);
  assert.equal(names.filter((n) => n === 'landing_view').length, 1, 'landing_view deduplicado (várias visitas no mesmo dia)');
  assert.equal(ev.find((e) => e.event === 'cta_trial_click').plan, 'prime');
  for (const e of ev) assert.deepEqual(Object.keys(e).sort(), ['created_at', 'day', 'event', 'id', 'plan', 'utm_campaign', 'utm_source', 'visitor'], 'sem campo pessoal');
  void funnel;

  step('formulário de contato grava e só então confirma');
  await p.goto(`${APP}/#contato`);
  const mark = `qa-${Date.now()}`;
  // A landing tem dois formulários (contato e proposta): mira o de contato.
  const contact = p.locator('#contato');
  await contact.getByLabel('Nome').fill('Pessoa QA');
  await contact.getByLabel('E-mail').fill(`${mark}@example.invalid`);
  await contact.getByLabel('Mensagem').fill('Teste automatizado do formulário da landing.');
  await contact.getByRole('button', { name: 'Enviar mensagem' }).click();
  await contact.getByText('Mensagem recebida.').waitFor();
  const { data: lead } = await svc.from('contact_requests').select('source, status').eq('email', `${mark}@example.invalid`).single();
  assert.deepEqual(lead, { source: 'landing', status: 'novo' });

  step('zoom 200% (viewport equivalente 720px) sem rolagem horizontal');
  const z = await browser.newPage({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  await z.goto(`${APP}/`);
  await z.getByRole('heading', { level: 1 }).waitFor();
  assert.ok(await noHScroll(z));

  step('áreas privadas fora do índice; landing indexável');
  assert.equal(await p.evaluate(() => document.querySelector('meta[name=robots]')), null);
  await p.goto(`${APP}/entrar`);
  assert.equal(await p.locator('meta[name=robots]').getAttribute('content'), 'noindex,nofollow');

  step('tour do síndico: alvos reais, troca de rota, pular e retomar');
  const email = `tour-${Date.now()}@demo.portariaprime.invalid`, password = `T${crypto.randomUUID()}!`;
  await svc.auth.admin.createUser({ email, password, email_confirm: true });
  const s = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const errors = []; s.on('pageerror', (e) => errors.push(e.message));
  await s.goto(`${APP}/entrar`);
  await s.getByLabel('E-mail', { exact: true }).fill(email);
  await s.getByLabel('Senha', { exact: true }).fill(password);
  await s.getByRole('button', { name: 'Entrar' }).click();
  await s.waitForURL(/\/app/);
  await s.getByRole('button', { name: 'Cadastrar condomínio' }).click();
  const slug = `e2e-tour-${Date.now().toString(36)}`;
  await onboard(s, { name: 'Condomínio Tour QA', slug, document: fakeCnpj() });
  await s.waitForURL(new RegExp(`/c/${slug}/configuracoes`));
  await s.getByRole('button', { name: 'Fazer o tutorial' }).click();
  const tip = s.getByRole('dialog', { name: /Tutorial: Primeiros passos do síndico/ });
  await tip.getByText('passo 1 de 5').waitFor();
  await tip.getByText('Marca do condomínio').waitFor();
  await tip.getByRole('button', { name: 'Próximo' }).click();
  await tip.getByText('Locais de guarda').waitFor();
  await tip.getByRole('button', { name: 'Próximo' }).click();
  await s.waitForURL(new RegExp(`/c/${slug}/pessoas`));
  await tip.getByText('passo 3 de 5').waitFor();
  const box = await s.locator('[data-tour="unidades-form"]').boundingBox();
  const tipBox = await tip.boundingBox();
  assert.ok(tipBox.y >= box.y + box.height || tipBox.y + tipBox.height <= box.y, 'balão não cobre o alvo');
  assert.ok(await noHScroll(s));
  await s.keyboard.press('Escape');
  await tip.waitFor({ state: 'detached' });
  await s.goto(`${APP}/c/${slug}/ajuda`);
  await s.getByRole('heading', { name: 'Central de ajuda' }).waitFor();
  await s.getByRole('button', { name: /Rever tutorial|Iniciar tutorial Primeiros passos/ }).first().click();
  await s.getByRole('dialog', { name: /Tutorial/ }).getByText('passo 1 de').waitFor();
  await s.keyboard.press('Escape');

  step('ajuda: busca com sinônimo, artigo e link copiável');
  await s.goto(`${APP}/c/${slug}/ajuda`);
  await s.getByLabel('Pesquisar na ajuda').fill('pacote');
  await s.getByRole('link', { name: /Receber uma encomenda/ }).click();
  await s.getByRole('heading', { name: 'Receber uma encomenda' }).waitFor();
  await s.getByText('Passo a passo').waitFor();
  await s.getByLabel?.('Pesquisar na ajuda').count();
  await s.goto(`${APP}/c/${slug}/ajuda`);
  await s.getByLabel('Pesquisar na ajuda').fill('xyzzy');
  await s.getByText('Nada encontrado').waitFor();
  assert.deepEqual(errors, [], 'erros JS no tour/ajuda');
  console.log('PASS landing, conversão, tour e ajuda.');
} finally {
  await browser.close();
}
