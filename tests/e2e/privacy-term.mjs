// Termo LGPD no NAVEGADOR REAL contra a pilha LOCAL (Auth com confirmação automática, igual à produção).
// Síndico cria o condomínio → vale o termo PADRÃO (global) com o nome do condomínio → morador lê, marca e envia →
// fila mostra contador e versão aceita → aprovação → síndico publica termo PRÓPRIO (opcional, com senha) →
// morador seguinte aceita o próprio → nova versão arquiva a anterior. Portal público só do morador.
//   PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/privacy-term.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase, fakeCnpj, onboard } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase local.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
await mkdir('tests/evidence', { recursive: true });
const run = `e2e${Date.now().toString(36)}`;
const slug = `${run}-lgpd`;
const step = (m) => console.log(`• ${m}`);
// Banco local da pilha (PP_STACK_DB vem do .env.stack.local; só loopback).
const sql = (q) => {
  const db = process.env.PP_STACK_DB;
  if (!db || !/@127\.0\.0\.1:/.test(db)) throw new Error('PP_STACK_DB local ausente.');
  const r = spawnSync(`${process.env.LOCALAPPDATA}/pp-stack/pg17/pgsql/bin/psql.exe`, [db, '-qAt', '-c', q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const browser = await chromium.launch();
const PASS = 'SenhaForte123!';
async function user(key, name) {
  const email = `${run}-${key}@e2e.portariaprime.invalid`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  return { email, id: data.user.id };
}
async function login(page, who, next) {
  await page.goto(`${APP}/entrar?next=${encodeURIComponent(next)}`);
  await page.getByLabel('E-mail').fill(who.email);
  await page.getByLabel('Senha').fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
}
const errors = [];

try {
  const sindico = await user('sindico', 'Síndica LGPD');
  const ana = await user('ana', 'Ana Moradora');
  const bia = await user('bia', 'Bia Moradora');

  step('síndico cria o condomínio pelo onboarding');
  const sCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const s = await sCtx.newPage();
  s.on('pageerror', (e) => errors.push(`síndico: ${e.message}`));
  await login(s, sindico, '/onboarding');
  await s.getByRole('heading', { name: 'Dados do condomínio' }).waitFor();
  await onboard(s, { name: 'Residencial LGPD', slug, document: fakeCnpj() });
  await s.waitForURL(new RegExp(`/c/${slug}/`));
  const { data: tenant } = await svc.from('tenants').select('id').eq('slug', slug).single();
  await svc.from('units').insert({ tenant_id: tenant.id, block: 'A', label: '101' });

  step('portal público: só morador (sem Administração/Portaria)');
  const pub = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await pub.goto(`${APP}/c/${slug}`);
  await pub.getByRole('heading', { name: 'Bem-vindo(a) ao portal dos moradores' }).waitFor();
  assert.ok(await pub.getByRole('button', { name: 'Entrar como morador' }).isVisible());
  assert.ok(await pub.getByRole('button', { name: 'Criar minha conta' }).isVisible());
  assert.equal(await pub.getByRole('button', { name: /Administração|Portaria/ }).count(), 0, 'sem cartões de equipe no portal');
  assert.equal(await pub.getByText(/Área da portaria|Administração do condomínio/).count(), 0);
  await pub.screenshot({ path: 'tests/evidence/lgpd-portal-publico-390.png', fullPage: true });
  // Rota protegida continua protegida: visitante vai ao login, não ao painel.
  await pub.goto(`${APP}/c/${slug}/portaria`);
  await pub.waitForURL(/\/c\/[^/]+$|\/entrar/);
  assert.ok(!/\/portaria$/.test(new URL(pub.url()).pathname), 'visitante não abre a portaria');

  step('sem termo próprio: morador (conta sem rascunho) vê o termo padrão com o nome do condomínio');
  const aCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await aCtx.newPage();
  a.on('pageerror', (e) => errors.push(`ana: ${e.message}`));
  await login(a, ana, `/c/${slug}/solicitar`);
  await a.getByRole('heading', { name: 'Cadastro de morador' }).waitFor();
  await a.getByText('versão 1.0').first().waitFor();
  const box = a.getByRole('checkbox');
  assert.equal(await box.isChecked(), false, 'checkbox inicia desmarcado');
  await a.getByRole('button', { name: 'Ler o termo completo' }).click();
  await a.getByRole('region', { name: /Proteção de dados pessoais/ }).getByText(/morador efetivo do Residencial LGPD/).waitFor();
  await a.getByLabel('Nome completo').fill('Ana Moradora');
  await a.getByLabel('Celular / WhatsApp').fill('11988887777');
  assert.equal(await a.getByLabel('Celular / WhatsApp').inputValue(), '(11) 98888-7777', 'máscara do celular');
  await a.getByLabel('Bloco', { exact: true }).selectOption('A');
  await a.getByLabel('Apartamento', { exact: true }).selectOption('101');
  await a.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await a.getByText('Marque a ciência do termo de tratamento de dados.').waitFor();
  assert.equal(sql(`select count(*) from public.access_requests where user_id = '${ana.id}'`), '0', 'sem aceite nada é enviado');
  await box.check();
  await a.screenshot({ path: 'tests/evidence/lgpd-morador-termo-390.png', fullPage: true });
  await a.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await a.getByRole('heading', { name: 'Cadastro recebido com sucesso!' }).waitFor();
  await a.getByText('versão 1.0 aceita').waitFor();

  step('servidor: aceite do termo padrão com versão, hashes e hora do servidor; nada aceito sem hash');
  const { data: acks } = await svc.from('privacy_acknowledgements').select('term_version, term_hash, displayed_text_hash, global_term_id, tenant_name_shown, accepted_at, access_request_id').eq('user_id', ana.id);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].term_version, '1.0');
  assert.ok(acks[0].global_term_id, 'termo padrão');
  assert.equal(acks[0].tenant_name_shown, 'Residencial LGPD');
  assert.match(acks[0].displayed_text_hash, /^[0-9a-f]{64}$/);
  assert.ok(acks[0].access_request_id);
  const bypass = await b2b(bia);
  assert.match(bypass, /aceite o termo|termo/i, `envio sem hash recusado: ${bypass}`);

  step('síndico: termo padrão vigente (sem aviso de bloqueio); contador no menu; fila com aceite; aprova');
  await s.goto(`${APP}/c/${slug}/configuracoes?m=privacidade`);
  await s.getByRole('heading', { name: 'Privacidade e LGPD' }).waitFor();
  await s.getByText('Termo padrão Portaria Prime: versão 1.0').waitFor();
  assert.equal(await s.getByText('Nenhum termo publicado.').count(), 0);
  await s.getByTestId('badge-pessoas').first().waitFor();
  assert.equal(await s.getByTestId('badge-pessoas').first().innerText(), '1', 'contador de pendentes no menu');
  await s.goto(`${APP}/c/${slug}/pessoas`);
  await s.getByText('Termo de dados 1.0 aceito em').waitFor();
  const li = s.locator('li', { hasText: 'Ana Moradora' });
  await li.getByRole('combobox').selectOption({ label: 'A 101' }).catch(async () => { await li.getByRole('combobox').selectOption({ index: 1 }); });
  await li.getByRole('button', { name: 'Aprovar' }).click();
  await s.getByText('Cadastro aprovado.').waitFor();
  await s.getByTestId('badge-pessoas').first().waitFor({ state: 'detached' });

  step('síndico cria termo PRÓPRIO (opcional) a partir do padrão e salva o rascunho');
  await s.goto(`${APP}/c/${slug}/configuracoes?m=privacidade`);
  await s.getByRole('button', { name: 'Criar termo próprio (opcional)' }).click();
  assert.match(await s.getByLabel('Texto do termo').inputValue(), /morador efetivo do Residencial LGPD/);
  await s.getByLabel('Versão').fill('2.0');
  await s.getByLabel('O que mudou (opcional)').fill('Termo próprio');
  await s.getByRole('button', { name: 'Salvar rascunho' }).click();
  await s.getByText('Rascunho da versão 2.0').waitFor();

  step('publicar exige senha recente: pede senha → senha errada recusada → certa publica');
  // A regra real (login ≤ 5 min) é coberta no banco (tests/db/privacy-terms.test.mjs). Aqui a 1ª chamada
  // recebe exatamente a resposta que o banco dá com sessão antiga, para validar o fluxo da tela.
  let first = true;
  await s.route('**/rpc/privacy_term_publish', (r) => {
    if (!first) return r.continue();
    first = false;
    return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Confirme sua senha para esta ação.', hint: 'reauth', details: null }) });
  });
  await s.getByRole('button', { name: 'Publicar versão 2.0' }).click();
  await s.getByRole('button', { name: 'Publicar agora' }).click();
  const reauth = s.getByRole('dialog', { name: 'Confirme sua senha' });
  await reauth.waitFor();
  assert.equal((await svc.from('privacy_terms').select('status').eq('tenant_id', tenant.id)).data[0].status, 'draft', 'nada publicado antes da senha');
  await reauth.getByLabel('Senha').fill('senha-errada-123');
  await reauth.getByRole('button', { name: 'Confirmar' }).click();
  await reauth.getByText('Senha incorreta.').waitFor();
  await reauth.getByLabel('Senha').fill(PASS);
  await reauth.getByRole('button', { name: 'Confirmar' }).click();
  await s.getByText('Termo vigente: versão 2.0').waitFor();
  await s.unroute('**/rpc/privacy_term_publish');
  await s.screenshot({ path: 'tests/evidence/lgpd-sindico-publicado.png', fullPage: true });

  await s.getByRole('heading', { name: 'Registros de aceite' }).waitFor();
  await s.getByRole('cell', { name: 'Ana Moradora' }).waitFor();
  await s.getByRole('cell', { name: 'v1.0 (padrão)' }).waitFor();

  step('próximo morador aceita o termo próprio 2.0');
  const b = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await login(b, bia, `/c/${slug}/solicitar`);
  await b.getByText('versão 2.0').first().waitFor();
  await b.getByLabel('Nome completo').fill('Bia Moradora');
  await b.getByLabel('Celular / WhatsApp').fill('21987654321');
  await b.getByLabel('Bloco', { exact: true }).selectOption('A');
  await b.getByLabel('Apartamento', { exact: true }).selectOption('101');
  await b.getByRole('checkbox').check();
  await b.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await b.getByText('versão 2.0 aceita').waitFor();

  step('nova versão 2.1: a 2.0 é arquivada com o aceite preservado');
  await s.getByRole('button', { name: 'Criar nova versão' }).click();
  assert.equal(await s.getByLabel('Versão').inputValue(), '2.1');
  await s.getByLabel('Texto do termo').fill(`${await s.getByLabel('Texto do termo').inputValue()}\n\nCanal de contato do encarregado: administração do condomínio.`);
  await s.getByRole('button', { name: 'Salvar rascunho' }).click();
  await s.getByRole('button', { name: 'Publicar versão 2.1' }).click();
  await s.getByRole('button', { name: 'Publicar agora' }).click();
  if (await reauth.waitFor({ timeout: 5000 }).then(() => true).catch(() => false)) { await reauth.getByLabel('Senha').fill(PASS); await reauth.getByRole('button', { name: 'Confirmar' }).click(); }
  await s.getByText('Termo vigente: versão 2.1').waitFor();
  const hist = s.locator('section', { has: s.getByRole('heading', { name: /Termo próprio do condomínio/ }) });
  await hist.getByText('Arquivada').waitFor();
  assert.ok(await hist.locator('li', { hasText: 'v2.0' }).getByText('1 aceite(s)').count());

  assert.deepEqual(errors, [], `sem erros de JavaScript: ${errors.join(' | ')}`);
  console.log('OK privacy-term');
} finally {
  await browser.close();
}

/** Chama request_access como a Bia, pela API pública, SEM o hash (o que um script mal-intencionado faria). */
async function b2b(who) {
  const c = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email: who.email, password: PASS });
  const { error } = await c.rpc('request_access', { p_slug: slug, p_full_name: 'Bia Script', p_phone: '11977776666', p_block: 'A', p_unit: '101', p_privacy_hash: null });
  // access_requests não é exposta à service_role pela API; confere direto no banco local.
  assert.equal(sql(`select count(*) from public.access_requests where user_id = '${who.id}'`), '0', 'nada gravado sem aceite');
  return error?.message || 'ACEITO (falha!)';
}
