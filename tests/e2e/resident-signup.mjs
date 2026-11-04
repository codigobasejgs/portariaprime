// Cadastro do morador em UMA etapa, no NAVEGADOR REAL contra a pilha LOCAL (Auth com confirmação automática,
// igual à produção). Nenhum envio externo: o worker de avisos não roda; só confere a fila (outbox).
// Portal → "Criar minha conta" → formulário completo (bloco/unidade reais, máscara, termo desmarcado) →
// clique duplo = 1 conta e 1 pedido → "Cadastro recebido" persiste no F5 → login só com e-mail e senha →
// contador e aprovação do síndico → login vai direto ao app. Também: e-mail já cadastrado, cadastro com
// confirmação de e-mail (rascunho no servidor), revisão quando o termo muda, recusa e isolamento entre condomínios.
//   PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/resident-signup.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !anon || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase local.');
assertLocalSupabase(url);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(url, secret, opts);
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
await mkdir('tests/evidence', { recursive: true });
const run = `e2e${Date.now().toString(36)}`;
const slug = `${run}-cad`, slugB = `${run}-outro`;
const step = (m) => console.log(`• ${m}`);
const sql = (q) => {
  const db = process.env.PP_STACK_DB;
  if (!db || !/@127\.0\.0\.1:/.test(db)) throw new Error('PP_STACK_DB local ausente.');
  const r = spawnSync(`${process.env.LOCALAPPDATA}/pp-stack/pg17/pgsql/bin/psql.exe`, [db, '-qAt', '-c', q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const PASS = 'SenhaForte123!';
const mail = (k) => `${run}-${k}@e2e.portariaprime.invalid`;
async function account(key, name, meta = {}) {
  const email = mail(key);
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name, ...meta } });
  if (error) throw error;
  const client = createClient(url, anon, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password: PASS });
  if (e2) throw e2;
  return { email, id: data.user.id, client };
}
const call = async (who, fn, args) => {
  const { data, error } = await who.client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};
const uid = (email) => sql(`select id from auth.users where email = '${email}'`);
async function login(p, email, next) {
  await p.goto(`${APP}/entrar?next=${encodeURIComponent(next)}&portal=${slug}`);
  await p.getByLabel('E-mail').fill(email);
  await p.getByLabel('Senha').fill(PASS);
  await p.getByRole('button', { name: 'Entrar' }).click();
}
async function fill(p, { name, email, phone, block, unit, password = PASS }) {
  await p.getByLabel('Nome completo').fill(name);
  if (email) await p.getByLabel('E-mail').fill(email);
  await p.getByLabel('Celular / WhatsApp').fill(phone);
  if (block) await p.getByLabel('Bloco / Torre').selectOption(block);
  await p.getByLabel('Apartamento / Unidade').selectOption(unit);
  if (email) { await p.getByLabel('Senha', { exact: true }).fill(password); await p.getByLabel('Confirme a senha').fill(password); }
}
const browser = await chromium.launch();
const errors = [];
const watch = (p, who) => p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));

try {
  step('fixtures: condomínio com blocos A/B e unidades reais; outro condomínio para isolamento');
  const sindico = await account('sindico', 'Síndica Cadastro');
  const { tenant_id: T } = await call(sindico, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Residencial Jardim', p_slug: slug,
    p_document: String(Date.now()).padStart(14, '4').slice(-14), p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly', p_contact_phone: null });
  await sindico.client.from('units').insert([{ tenant_id: T, block: 'A', label: '101' }, { tenant_id: T, block: 'A', label: '102' }, { tenant_id: T, block: 'B', label: '201' }]);
  const outro = await account('sindico2', 'Síndico Outro');
  const { tenant_id: T2 } = await call(outro, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Condomínio Vizinho', p_slug: slugB,
    p_document: String(Date.now() + 7).padStart(14, '5').slice(-14), p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly', p_contact_phone: null });
  await outro.client.from('units').insert({ tenant_id: T2, block: null, label: '9' });

  step('portal → "Criar minha conta" abre o cadastro completo (celular 390px)');
  const mCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mCtx.newPage(); watch(m, 'morador');
  await m.goto(`${APP}/c/${slug}`);
  await m.getByRole('button', { name: 'Criar minha conta' }).click();
  await m.getByRole('heading', { name: 'Criar minha conta' }).waitFor();
  for (const l of ['Nome completo', 'E-mail', 'Celular / WhatsApp', 'Bloco / Torre', 'Apartamento / Unidade', 'Confirme a senha']) await m.getByLabel(l).waitFor();
  assert.equal(await m.getByRole('checkbox').isChecked(), false, 'aceite inicia desmarcado');
  assert.deepEqual(await m.getByLabel('Bloco / Torre').locator('option').allInnerTexts(), ['Selecione', 'A', 'B'], 'blocos reais');
  assert.ok(await m.getByLabel('Apartamento / Unidade').isDisabled(), 'unidade depois do bloco');
  await m.getByLabel('Bloco / Torre').selectOption('B');
  assert.deepEqual(await m.getByLabel('Apartamento / Unidade').locator('option').allInnerTexts(), ['Selecione', '201', 'Minha unidade não está na lista'], 'só unidades do bloco B');
  assert.equal(await m.getByText('Já tenho conta — Entrar').count(), 1);
  assert.ok(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sem rolagem horizontal');

  step('validação no envio: campos destacados, nenhuma conta criada');
  await m.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await m.getByText('Informe nome e sobrenome.').waitFor();
  await m.getByText('Marque a ciência do termo de tratamento de dados.').waitFor();
  await m.getByLabel('Celular / WhatsApp').fill('1133334444');
  await m.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await m.getByText(/Informe o celular com DDD/).waitFor();
  assert.equal(uid(mail('ana')), '', 'sem conta antes de validar');

  step('preenche, clique duplo no envio → 1 conta, 1 pedido; tela "Cadastro recebido com sucesso!"');
  await fill(m, { name: 'Ana Paula Souza', email: mail('ana').toUpperCase(), phone: '11988887777', block: 'A', unit: '102' });
  assert.equal(await m.getByLabel('Celular / WhatsApp').inputValue(), '(11) 98888-7777');
  await m.getByRole('checkbox').check();
  await m.screenshot({ path: 'tests/evidence/cadastro-formulario-390.png', fullPage: true });
  await m.getByRole('button', { name: 'Enviar meu cadastro' }).dblclick();
  await m.getByRole("heading", { name: "Cadastro recebido com sucesso!" }).waitFor({ timeout: 20000 });
  await m.getByText('Aguardando aprovação').waitFor();
  await m.getByText('A 102').waitFor();
  await m.screenshot({ path: 'tests/evidence/cadastro-recebido-390.png', fullPage: true });
  const ana = uid(mail('ana'));
  assert.ok(ana, 'conta criada com e-mail normalizado');
  assert.equal(sql(`select count(*) from auth.users where email = '${mail('ana')}'`), '1');
  assert.equal(sql(`select count(*)||'|'||min(status)||'|'||min(phone)||'|'||bool_and(unit_id is not null) from public.access_requests where user_id = '${ana}'`), '1|pending|+5511988887777|true');
  assert.equal(sql(`select count(*) from public.privacy_acknowledgements where user_id = '${ana}' and global_term_id is not null and displayed_text_hash ~ '^[0-9a-f]{64}$'`), '1', 'aceite do termo padrão');
  assert.equal(sql(`select count(*) from public.resident_signup_drafts where user_id = '${ana}'`), '0', 'rascunho consumido');
  assert.equal(sql(`select string_agg(event||':'||channel, ',' order by event, channel) from public.notification_jobs where ref_id = (select id::text from public.access_requests where user_id = '${ana}')`),
    'access_received:email,access_received:whatsapp,access_request:email,access_request:push', 'avisos na fila (morador e síndico), nada enviado aqui');
  assert.equal(sql(`select full_name from public.profiles where id = '${ana}'`), 'Ana Paula Souza');

  step('F5 mantém a tela de recebido; sair e entrar só com e-mail e senha não pede dados de novo');
  await m.reload();
  await m.getByRole('heading', { name: 'Cadastro recebido com sucesso!' }).waitFor();
  await mCtx.clearCookies(); await m.evaluate(() => localStorage.clear());
  await login(m, mail('ana'), `/c/${slug}/solicitar`);
  await m.getByRole('heading', { name: 'Cadastro recebido com sucesso!' }).waitFor();
  assert.equal(await m.getByLabel('Nome completo').count(), 0, 'sem formulário depois do login');

  step('síndico: contador no menu, pedido com dados e aceite; aprova');
  const sCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const s = await sCtx.newPage(); watch(s, 'síndico');
  await s.goto(`${APP}/entrar?next=${encodeURIComponent(`/c/${slug}/pessoas`)}`);
  await s.getByLabel('E-mail').fill(sindico.email); await s.getByLabel('Senha').fill(PASS); await s.getByRole('button', { name: 'Entrar' }).click();
  await s.getByTestId('badge-pessoas').first().waitFor();
  assert.equal(await s.getByTestId('badge-pessoas').first().innerText(), '1');
  const li = s.locator('li', { hasText: 'Ana Paula Souza' });
  await li.getByText('(11) 98888-7777').waitFor();
  await li.getByText(/Termo de dados 1\.0 aceito/).waitFor();
  await s.screenshot({ path: 'tests/evidence/cadastro-fila-sindico-1280.png', fullPage: true });
  await li.getByRole('button', { name: 'Aprovar' }).click();
  await s.getByText('Cadastro aprovado.').waitFor();
  await s.getByTestId('badge-pessoas').first().waitFor({ state: 'detached' });
  assert.equal(sql(`select string_agg(channel, ',' order by channel) from public.notification_jobs where event = 'access_decision' and ref_id = (select id::text from public.access_requests where user_id = '${ana}')`), 'email,whatsapp');

  step('morador: "Acompanhar minha solicitação" entra no app; novo login vai direto ao app');
  await m.getByRole('button', { name: 'Acompanhar minha solicitação' }).click();
  await m.waitForURL(new RegExp(`/c/${slug}/inicio`));
  await mCtx.clearCookies(); await m.evaluate(() => localStorage.clear());
  await login(m, mail('ana'), `/c/${slug}`);
  await m.waitForURL(new RegExp(`/c/${slug}/inicio`));

  step('e-mail já cadastrado: orienta a entrar, sem criar outra conta');
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(d, 'repetido');
  await d.goto(`${APP}/cadastro?next=${encodeURIComponent(`/c/${slug}/solicitar`)}&portal=${slug}`);
  await fill(d, { name: 'Ana Outra Vez', email: mail('ana'), phone: '11988887777', block: 'A', unit: '101' });
  await d.getByRole('checkbox').check();
  await d.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await d.getByText(/Este e-mail já tem conta/).waitFor();
  assert.equal(sql(`select count(*) from public.access_requests where user_id = '${ana}'`), '1');
  await d.screenshot({ path: 'tests/evidence/cadastro-formulario-1280.png', fullPage: true });

  step('confirmação de e-mail (rascunho no servidor): 1º login cria o pedido sem perguntar nada');
  const { hash } = await call(sindico, 'privacy_term_current', { p_slug: slug });
  const caio = await account('caio', 'Caio Mendes', { pp_signup: { slug, full_name: 'Caio Mendes', phone: '21987654321', block: 'B', unit: '201', privacy_hash: hash } });
  assert.equal(sql(`select count(*) from public.resident_signup_drafts where user_id = '${caio.id}'`), '1', 'rascunho guardado pelo servidor');
  await call(outro, 'access_incomplete_signups', { p_tenant: T }).then((x) => assert.equal(x, null, 'outro condomínio não vê o rascunho'));
  assert.equal((await call(sindico, 'access_incomplete_signups', { p_tenant: T })).length, 1);
  const c = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage(); watch(c, 'caio');
  await login(c, caio.email, `/c/${slug}/solicitar`);
  await c.getByRole('heading', { name: 'Cadastro recebido com sucesso!' }).waitFor();
  await c.getByText('B 201').waitFor();
  assert.equal(sql(`select count(*) from public.access_requests where user_id = '${caio.id}' and status = 'pending'`), '1');

  step('termo mudou entre cadastro e confirmação: revisa com dados preenchidos e aceite desmarcado');
  const duda = await account('duda', 'Duda Ramos', { pp_signup: { slug, full_name: 'Duda Ramos', phone: '31991234567', block: 'A', unit: '101', privacy_hash: 'f'.repeat(64) } });
  const r = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage(); watch(r, 'duda');
  await login(r, duda.email, `/c/${slug}/solicitar`);
  await r.getByRole('heading', { name: 'Revise seu cadastro' }).waitFor();
  assert.equal(await r.getByLabel('Nome completo').inputValue(), 'Duda Ramos');
  assert.equal(await r.getByLabel('Celular / WhatsApp').inputValue(), '(31) 99123-4567');
  assert.equal(await r.getByLabel('Apartamento / Unidade').inputValue(), '101');
  assert.equal(await r.getByRole('checkbox').isChecked(), false);
  assert.equal(await r.getByLabel('E-mail').count(), 0, 'sem e-mail/senha para quem já tem conta');
  await r.getByRole('checkbox').check();
  await r.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await r.getByRole('heading', { name: 'Cadastro recebido com sucesso!' }).waitFor();

  step('recusa: morador vê o motivo e reenvia com os dados anteriores');
  const [dudaReq] = (await call(sindico, 'list_access_requests', { p_tenant: T, p_status: 'pending' })).filter((x) => x.full_name === 'Duda Ramos');
  await call(sindico, 'decide_access_request', { p_request: dudaReq.id, p_approve: false, p_unit: null, p_reason: 'Unidade não confere' });
  await r.getByRole('button', { name: 'Acompanhar minha solicitação' }).click();
  await r.getByText(/não foi aprovada: Unidade não confere/).waitFor();
  assert.equal(await r.getByLabel('Nome completo').inputValue(), 'Duda Ramos');
  assert.equal(await r.getByLabel('Celular / WhatsApp').inputValue(), '(31) 99123-4567', 'celular do pedido anterior');
  await r.getByRole('checkbox').check();
  await r.getByRole('button', { name: 'Enviar meu cadastro' }).click();
  await r.getByRole('heading', { name: 'Cadastro recebido com sucesso!' }).waitFor();
  const [duda2] = (await call(sindico, 'list_access_requests', { p_tenant: T, p_status: 'pending' })).filter((x) => x.full_name === 'Duda Ramos');
  assert.ok(duda2.privacy_version, 'reenvio com aceite próprio');
  assert.equal((await call(sindico, 'decide_access_request', { p_request: duda2.id, p_approve: true, p_unit: null, p_reason: null })).status, 'approved');
  await r.getByRole('button', { name: 'Acompanhar minha solicitação' }).click();
  await r.waitForURL(new RegExp(`/c/${slug}/inicio`));

  step('isolamento: conta do condomínio A no portal B vê só as unidades e o termo de B');
  await r.goto(`${APP}/c/${slugB}/solicitar`);
  await r.getByRole('heading', { name: 'Cadastro de morador' }).waitFor();
  assert.deepEqual(await r.getByLabel('Apartamento / Unidade').locator('option').allInnerTexts(), ['Selecione', '9', 'Minha unidade não está na lista']);
  await r.getByRole('button', { name: 'Ler o termo completo' }).click();
  await r.getByText(/morador efetivo do Condomínio Vizinho/).waitFor();
  assert.equal(await r.getByText('Residencial Jardim').count(), 0);
  assert.equal(await call(outro, 'access_requests_pending_count', { p_tenant: T }), 0, 'contador de A negado ao síndico de B');

  assert.deepEqual(errors, [], `sem erros de JavaScript: ${errors.join(' | ')}`);
  console.log('OK resident-signup');
} finally {
  await browser.close();
}
