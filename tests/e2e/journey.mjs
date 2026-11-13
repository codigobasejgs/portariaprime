// Jornada do síndico iniciante no NAVEGADOR REAL contra Supabase REAL (dados sintéticos).
// Cadastro → condomínio + mês grátis → marca → local → unidade → convite porteiro/morador →
// receber → QR do morador → entregar com assinatura → comprovante → relatório.
// Contas criadas pela service role já confirmadas (não há caixa de e-mail no teste).
// Somente Supabase local isolado. Preserva fixtures para diagnóstico.
// Capturas de QA em tests/evidence/journey-*.png (fora do Git); não são material comercial.
//
// PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 SUPABASE_URL=... SUPABASE_ANON_KEY=... \
//   SUPABASE_SERVICE_ROLE_KEY=... node tests/e2e/journey.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase, fakeCnpj, onboard } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !anon || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const run = `e2e${Date.now().toString(36)}`;
const slug = `${run}-jornada`;
const created = [];
let tenantId = null;
const evidence = 'tests/evidence';
await mkdir(evidence, { recursive: true });

const { count } = await svc.from('tenants').select('id', { count: 'exact', head: true }).not('slug', 'like', 'e2e%');
assert.equal(count, 0, 'Banco contém condomínios reais: jornada recusada.');
const { data: plansBefore } = await svc.from('plans').select('code, published');
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);

async function account(key) {
  const email = `${run}-${key}@e2e.portariaprime.invalid`;
  const password = `S${crypto.randomUUID()}!`;
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `Pessoa ${key}` } });
  if (error) throw error;
  created.push(data.user.id);
  return { email, password, id: data.user.id };
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });

// PP_E2E_RELAY=1: em redes onde o navegador não alcança o Supabase mas o Node alcança,
// as requisições HTTP ao Supabase são repassadas pelo Node (sem alterar conteúdo).
// Realtime (WebSocket) não passa pelo repasse; a jornada não depende dele.
async function relay(context) {
  if (process.env.PP_E2E_RELAY !== '1') return;
  await context.route(`${url}/**`, async (route) => {
    const req = route.request();
    const res = await fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
    const headers = Object.fromEntries(res.headers);
    delete headers['content-encoding'];
    delete headers['content-length'];
    await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
}
const newContext = async (options) => { const c = await browser.newContext(options); await relay(c); return c; };
const step = (name) => console.log(`• ${name}`);
const shot = (page, name) => page.screenshot({ path: `${evidence}/journey-${name}.png`, fullPage: true });
async function login(page, who) {
  await page.goto(`${APP}/entrar`);
  await page.getByLabel('E-mail', { exact: true }).fill(who.email);
  await page.getByLabel('Senha', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}
async function acceptInvite(context, link, who) {
  const page = await context.newPage();
  await login(page, who);
  await page.waitForURL(/\/app|\/c\//);
  await page.goto(link);
  await page.getByRole('button', { name: 'Aceitar convite' }).click();
  await page.waitForURL(/\/c\//);
  return page;
}

try {
  const sindico = await account('sindico');
  const porteiro = await account('porteiro');
  const morador = await account('morador');
  const errors = [];

  const sCtx = await newContext({ viewport: { width: 1440, height: 900 }, permissions: [] });
  const s = await sCtx.newPage();
  s.on('pageerror', (e) => errors.push(e.message));

  step('síndico entra e cadastra o condomínio com mês grátis (sem cartão)');
  await login(s, sindico);
  await s.waitForURL(/\/app/);
  await s.getByRole('button', { name: 'Cadastrar condomínio' }).click();
  await onboard(s, { name: 'Residencial Jornada E2E', slug, document: fakeCnpj() });
  await s.waitForURL(new RegExp(`/c/${slug}/configuracoes`));
  await s.getByText('Condomínio criado e mês grátis ativo').waitFor();
  ({ data: { id: tenantId } } = await svc.from('tenants').select('id').eq('slug', slug).single());
  const { data: sub } = await svc.from('subscriptions').select('status, trial_started_at, trial_ends_at').eq('tenant_id', tenantId).single();
  assert.equal(sub.status, 'trialing');
  assert.equal((await svc.from('billing_orders').select('id').eq('tenant_id', tenantId)).data.length, 0, 'nenhuma cobrança no início');

  step('personaliza a marca');
  await s.goto(`${APP}/c/${slug}/configuracoes?m=identidade`);
  await s.getByLabel('Nome exibido').fill('Jornada E2E');
  await s.getByRole('button', { name: 'Salvar' }).first().click();
  await s.getByText('Marca salva.').waitFor();
  await shot(s, 'personalizacao');

  step('cadastra local de guarda');
  await s.goto(`${APP}/c/${slug}/configuracoes?m=operacao`);
  await s.getByLabel('Código curto').fill('A-1');
  await s.getByLabel('Capacidade').fill('10');
  await s.getByRole('button', { name: 'Adicionar' }).click();
  await s.getByText('Local adicionado.').waitFor();

  step('cadastra unidade e convida porteiro e morador');
  await s.goto(`${APP}/c/${slug}/pessoas?aba=unidades`);
  await s.getByRole('button', { name: 'Nova unidade' }).click();
  await s.getByLabel('Bloco (opcional)').fill('A');
  await s.getByLabel('Apartamento', { exact: true }).fill('101');
  await s.getByRole('button', { name: 'Adicionar unidade' }).click();
  await s.getByText('Unidade cadastrada.').waitFor();

  const invite = async (open, email) => {
    await open();
    await s.getByLabel('E-mail da pessoa').fill(email);
    await s.getByRole('button', { name: 'Enviar convite' }).click();
    // Sem Resend configurado o sistema entrega o link para envio manual (não finge envio).
    const field = s.locator('input[readonly]');
    await field.waitFor();
    const link = await field.inputValue();
    await s.getByRole('button', { name: 'Fechar' }).click();
    return link;
  };
  await s.goto(`${APP}/c/${slug}/configuracoes?m=equipe`);
  const porteiroLink = await invite(() => s.getByRole('button', { name: 'Convidar por e-mail' }).first().click(), porteiro.email);
  await s.goto(`${APP}/c/${slug}/pessoas?aba=unidades`);
  const moradorLink = await invite(async () => {
    await s.getByRole('button', { name: /Ações de Bloco A · 101/ }).click();
    await s.getByRole('menuitem', { name: 'Convidar morador (opcional)' }).click();
  }, morador.email);
  assert.match(porteiroLink, /\/convite#[0-9a-f]{64}$/);

  step('porteiro e morador aceitam os convites');
  const pCtx = await newContext({ viewport: { width: 1024, height: 768 } });
  const p = await acceptInvite(pCtx, porteiroLink, porteiro);
  const mCtx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const m = await acceptInvite(mCtx, moradorLink, morador);

  step('porteiro registra a encomenda (digitação manual)');
  await p.goto(`${APP}/c/${slug}/portaria`);
  await p.getByRole('button', { name: 'Receber encomenda' }).click();
  await p.getByLabel('Nome do entregador (obrigatório)').fill('Entregador E2E - Correios');
  await p.getByRole('button', { name: 'Avançar', exact: true }).click();
  await p.getByLabel(/Unidade de destino/).fill('A 101');
  await p.getByRole('option', { name: /101/ }).click();
  await p.getByLabel(/Rastreio/).fill(`${run}BR`);
  await p.getByLabel(/Destinatário/).fill('Pessoa morador');
  await p.getByRole('button', { name: 'Salvar e avançar' }).click();
  // Com local de guarda cadastrado, a portaria confirma a guarda física antes de registrar.
  await p.getByText('Escolha o local e confirme').waitFor();
  await p.getByText(/Guardei fisicamente em/).click();
  await p.getByRole('button', { name: 'Salvar e avançar' }).click();
  await p.getByText(/Moradores da unidade avisados/).waitFor();
  await shot(p, 'recebimento');
  await p.getByRole('button', { name: 'Encerrar recebimento' }).click();
  await p.getByRole('list', { name: 'Encomendas recebidas' }).getByText(/101/).waitFor();
  await p.getByRole('button', { name: 'Finalizar' }).click();

  step('morador vê a encomenda e gera o QR');
  await m.goto(`${APP}/c/${slug}/inicio`);
  await m.getByRole('heading', { name: 'Você tem 1 encomenda para retirar' }).waitFor();
  await shot(m, 'morador');
  const { data: pkg } = await svc.from('packages').select('id').eq('tenant_id', tenantId).single();
  await m.getByRole('button', { name: 'Mostrar QR de retirada' }).click();
  await m.getByText('Uso único').waitFor();

  step('porteiro entrega com assinatura (sem QR: justificativa auditada)');
  await p.getByRole('button', { name: 'Entregar', exact: true }).click();
  await p.getByLabel('Quem está retirando').fill('Pessoa morador');
  await p.getByRole('button', { name: 'Avançar', exact: true }).click();
  await p.getByLabel('Justificativa').fill('Teste automatizado: QR exibido em outro aparelho');
  await p.getByRole('button', { name: 'Avançar', exact: true }).click();
  await p.locator('canvas').scrollIntoViewIfNeeded();
  const box = await p.locator('canvas').boundingBox();
  await p.mouse.move(box.x + 30, box.y + 40);
  await p.mouse.down();
  await p.mouse.move(box.x + 160, box.y + 90, { steps: 8 });
  await p.mouse.move(box.x + 260, box.y + 50, { steps: 8 });
  await p.mouse.up();
  // Foto do item é prova obrigatória da entrega.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await p.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'item.png', mimeType: 'image/png', buffer: png });
  await p.getByAltText('Foto do item entregue').waitFor();
  await p.getByRole('button', { name: 'Confirmar entrega' }).click();
  await p.getByText(/Protocolo PP-/).first().waitFor();
  await p.getByRole('button', { name: 'Ver comprovante' }).click();
  await p.getByRole('dialog', { name: 'Comprovante de retirada' }).waitFor();
  await p.getByText('Retirada por').waitFor();
  await shot(p, 'comprovante');
  const { data: receipt } = await svc.from('receipts').select('protocol, snapshot').eq('package_id', pkg.id).single();
  assert.match(receipt.protocol, /^PP-/);
  assert.equal(receipt.snapshot.method, 'manual');

  step('persistência após recarregar e relatório do síndico');
  await p.reload();
  await p.getByRole('tab', { name: 'Histórico' }).waitFor();
  await s.goto(`${APP}/c/${slug}/painel`);
  await s.getByText('Aguardando retirada agora').waitFor();
  await s.goto(`${APP}/c/${slug}/relatorios`);
  await s.getByRole('cell', { name: 'Retirada', exact: true }).first().waitFor();
  await shot(s, 'painel');

  step('assinatura mostra mês grátis com término e bloqueia cobrança antecipada');
  await s.goto(`${APP}/c/${slug}/configuracoes?m=plano`);
  await s.getByText(/Mês grátis de/).waitFor();
  await shot(s, 'assinatura');
  assert.equal(await s.getByRole('button', { name: /Pagar assinatura/ }).count(), 0, 'sem botão de pagar durante o teste');

  assert.deepEqual(errors, [], 'erros JavaScript na jornada do síndico');
  console.log('PASS jornada completa: cadastro, trial, marca, local, unidade, convites, recebimento, QR, entrega, comprovante, relatório, assinatura.');
} finally {
  await browser.close();
  // Fixtures permanecem na stack isolada para diagnóstico; nenhuma limpeza destrutiva remota.
  console.log(`Fixtures locais preservadas: ${slug}; usuários sintéticos: ${created.length}.`);
  for (const pl of plansBefore || []) await svc.from('plans').update({ published: pl.published }).eq('code', pl.code);
}
