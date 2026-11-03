// "Testar grátis" no NAVEGADOR REAL contra a pilha LOCAL (Auth com confirmação automática, igual à produção).
// Causa raiz corrigida: o signUp já cria a sessão; a pilha remontava /cadastro e mostrava o formulário
// vazio de novo (F5 idem). Agora: cadastro → etapas com rascunho no servidor → ativação única.
//   PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/trial-onboarding.mjs
// Requer o Auth local com GOTRUE_MAILER_AUTOCONFIRM=true (auth/run-autoconfirm.sh).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase, fakeCnpj } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase local.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
await mkdir('tests/evidence', { recursive: true });
const run = `e2e${Date.now().toString(36)}`;
const slug = `${run}-aurora`;
const cnpj = fakeCnpj(); // sintético, dígitos válidos, único por execução
const step = (m) => console.log(`• ${m}`);
const browser = await chromium.launch();
const users = [];

try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const mobile = label === 'mobile';
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    const provisions = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/provision_tenant')) provisions.push(r); });
    const email = `${run}-${label}@e2e.portariaprime.invalid`;

    step(`${label}: landing → Testar grátis → criar conta`);
    await page.goto(`${APP}/`);
    await page.getByRole('button', { name: 'Testar grátis por 1 mês' }).first().click();
    await page.waitForURL(/\/cadastro/);
    await page.getByRole('heading', { name: 'Criar conta' }).waitFor();
    await page.getByLabel('Seu nome').fill('Síndica Teste');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill('SenhaForte123!');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Criar conta' }).click();
    await page.getByRole('heading', { name: 'Dados do condomínio' }).waitFor();
    assert.match(page.url(), /\/onboarding/, 'conta criada segue para o onboarding, não repete o cadastro');
    assert.equal(await page.getByLabel('Seu nome').count(), 0, 'formulário de conta não aparece de novo');
    users.push((await svc.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email).id);

    step(`${label}: F5 no /cadastro com sessão vai ao onboarding`);
    await page.goto(`${APP}/cadastro?next=%2Fonboarding`);
    await page.getByRole('heading', { name: 'Dados do condomínio' }).waitFor();

    step(`${label}: etapa 1 → F5 na etapa 2 preserva dados`);
    const s = mobile ? `${slug}-m` : slug;
    await page.getByLabel('Nome do condomínio').fill('Residencial Aurora');
    await page.getByLabel('Endereço no sistema').fill(s);
    await page.getByLabel(/CNPJ/).fill('11.111.111/1111-11');
    await page.getByRole('button', { name: 'Escolher o plano' }).click();
    await page.getByText('CNPJ ou CPF inválido').waitFor();
    const doc = mobile ? cnpj.slice(0, 11).replace(/^./, '5') : cnpj; // mobile usa CPF
    const cpf = (() => { const b = doc.slice(0, 9); const dv = (x, w) => { const r = x.split('').reduce((a, c, i) => a + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; }; const d1 = dv(b, [10, 9, 8, 7, 6, 5, 4, 3, 2]); return b + d1 + dv(b + d1, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]); })();
    await page.getByLabel(/CNPJ/).fill(mobile ? cpf : cnpj);
    await page.getByRole('button', { name: 'Escolher o plano' }).click();
    await page.getByRole('heading', { name: 'Plano após o teste' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Plano após o teste' }).waitFor();

    step(`${label}: cada plano e cada periodicidade; Voltar preserva`);
    for (const c of ['Trimestral', 'Anual', 'Mensal']) { await page.getByRole('radio', { name: c, exact: true }).click(); }
    for (const p of ['Essencial', 'Prime', 'Profissional']) await page.locator('label', { hasText: p }).first().click();
    await page.getByRole('radio', { name: 'Anual', exact: true }).click();
    await page.getByRole('button', { name: 'Voltar' }).click();
    assert.equal(await page.getByLabel('Nome do condomínio').inputValue(), 'Residencial Aurora');
    assert.equal(await page.getByLabel('Endereço no sistema').inputValue(), s);
    await page.getByRole('button', { name: 'Escolher o plano' }).click();
    await page.getByRole('radio', { name: 'Anual', exact: true }).click();
    await page.getByRole('button', { name: 'Revisar e ativar' }).click();
    await page.getByRole('heading', { name: 'Revise e ative o mês grátis' }).waitFor();

    step(`${label}: fechar e reabrir retoma a revisão com o plano escolhido`);
    await page.close();
    const page2 = await ctx.newPage();
    page2.on('request', (r) => { if (r.url().includes('/rpc/provision_tenant')) provisions.push(r); });
    await page2.goto(`${APP}/onboarding`);
    await page2.getByRole('heading', { name: 'Revise e ative o mês grátis' }).waitFor();
    assert.ok(await page2.getByText('Profissional · Anual').count(), 'plano/periodicidade preservados');
    if (!mobile) await page2.screenshot({ path: 'tests/evidence/trial-revisao-desktop.png', fullPage: true });

    step(`${label}: falha temporária do servidor não perde nada; depois duplo clique ativa uma vez`);
    await page2.getByRole('checkbox').check();
    let fail = true;
    await page2.route('**/rpc/provision_tenant', (r) => { if (fail) { fail = false; return r.fulfill({ status: 503, body: '{"message":"indisponível"}' }); } return r.continue(); });
    await page2.getByRole('button', { name: 'Confirmar e ativar mês grátis' }).click();
    await page2.getByRole('alert').first().waitFor();
    assert.ok(await page2.getByRole('heading', { name: 'Revise e ative o mês grátis' }).count(), 'continua na revisão após erro');
    await page2.getByRole('button', { name: 'Confirmar e ativar mês grátis' }).dblclick();
    await page2.getByRole('heading', { name: 'Seu condomínio está pronto!' }).waitFor({ timeout: 20000 });
    const { data: t } = await svc.from('tenants').select('id, slug').eq('slug', s);
    assert.equal(t.length, 1, 'um único condomínio');
    const { data: subs } = await svc.from('subscriptions').select('status, cycle, trial_started_at, trial_ends_at').eq('tenant_id', t[0].id);
    assert.equal(subs.length, 1, 'um único período de teste');
    assert.equal(subs[0].status, 'trialing');
    assert.equal(subs[0].cycle, 'yearly');
    if (!mobile) await page2.screenshot({ path: 'tests/evidence/trial-sucesso-desktop.png', fullPage: true });
    else await page2.screenshot({ path: 'tests/evidence/trial-sucesso-mobile.png', fullPage: true });

    assert.ok(provisions.length >= 2, 'houve a tentativa com erro e a definitiva');
    assert.equal(new Set(provisions.map((r) => JSON.parse(r.postData()).p_request_id)).size, 1, 'todas as tentativas com o mesmo request_id');

    step(`${label}: F5 depois de ativar mostra o sucesso (não um formulário novo); Voltar do navegador idem`);
    await page2.reload();
    await page2.getByRole('heading', { name: 'Seu condomínio está pronto!' }).waitFor();
    await page2.goBack().catch(() => {});
    await page2.goto(`${APP}/onboarding`);
    await page2.getByRole('heading', { name: 'Seu condomínio está pronto!' }).waitFor();
    assert.equal((await svc.from('tenants').select('id').eq('slug', s)).data.length, 1);

    step(`${label}: login de novo com teste ativo → painel`);
    await page2.getByRole('button', { name: 'Acessar meu painel' }).click();
    await page2.waitForURL(new RegExp(`/c/${s}/`));
    await ctx.close();
  }

  step('F5 durante a ativação: servidor concluiu, resposta perdida → ao recarregar mostra o sucesso, sem segundo condomínio');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const email = `${run}-f5@e2e.portariaprime.invalid`;
    const { data: u } = await svc.auth.admin.createUser({ email, password: 'SenhaForte123!', email_confirm: true });
    users.push(u.user.id);
    await page.goto(`${APP}/entrar?next=%2Fonboarding`);
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill('SenhaForte123!');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByRole('heading', { name: 'Dados do condomínio' }).waitFor();
    const s = `${slug}-f5`;
    await page.getByLabel('Nome do condomínio').fill('Residencial F5');
    await page.getByLabel('Endereço no sistema').fill(s);
    await page.getByLabel(/CNPJ/).fill(fakeCnpj(Date.now() + 7));
    await page.getByRole('button', { name: 'Escolher o plano' }).click();
    await page.getByRole('button', { name: 'Revisar e ativar' }).click();
    await page.getByRole('checkbox').check();
    // A requisição chega ao servidor (condomínio criado), mas a página recarrega antes da resposta.
    let hit;
    const reached = new Promise((ok) => { hit = ok; });
    await page.route('**/rpc/provision_tenant', async (r) => { await r.fetch(); hit(); await new Promise(() => {}); });
    await page.getByRole('button', { name: 'Confirmar e ativar mês grátis' }).click();
    await reached;
    await page.unroute('**/rpc/provision_tenant');
    await page.reload();
    await page.getByRole('heading', { name: 'Seu condomínio está pronto!' }).waitFor();
    assert.equal((await svc.from('tenants').select('id').eq('slug', s)).data.length, 1);

    step('operação interrompida antes do servidor (rede caiu): ao reabrir, revisão preservada e ativação conclui uma vez');
    const s2 = `${slug}-rede`;
    await page.goto(`${APP}/onboarding?novo=1`);
    await page.getByRole('heading', { name: 'Dados do condomínio' }).waitFor();
    await page.getByLabel('Nome do condomínio').fill('Residencial Rede');
    await page.getByLabel('Endereço no sistema').fill(s2);
    await page.getByLabel(/CNPJ/).fill(fakeCnpj(Date.now() + 13));
    await page.getByRole('button', { name: 'Escolher o plano' }).click();
    await page.getByRole('button', { name: 'Revisar e ativar' }).click();
    await page.getByRole('checkbox').check();
    await page.route('**/rpc/provision_tenant', (r) => r.abort('internetdisconnected'));
    await page.getByRole('button', { name: 'Confirmar e ativar mês grátis' }).click();
    await page.getByRole('alert').first().waitFor();
    assert.equal((await svc.from('tenants').select('id').eq('slug', s2)).data.length, 0, 'nada criado sem o servidor');
    await page.unroute('**/rpc/provision_tenant');
    await page.close();
    const p2 = await ctx.newPage();
    await p2.goto(`${APP}/onboarding`);
    await p2.getByRole('heading', { name: 'Revise e ative o mês grátis' }).waitFor();
    assert.ok(await p2.getByText('Residencial Rede').count(), 'dados preservados, nada pedido de novo');
    await p2.getByRole('checkbox').check();
    await p2.getByRole('button', { name: 'Confirmar e ativar mês grátis' }).click();
    await p2.getByRole('heading', { name: 'Seu condomínio está pronto!' }).waitFor();
    assert.equal((await svc.from('tenants').select('id').eq('slug', s2)).data.length, 1);
    // O primeiro condomínio (F5) continua intacto, com um único período de teste.
    const { data: t1 } = await svc.from('tenants').select('id').eq('slug', s).single();
    assert.equal((await svc.from('subscriptions').select('id').eq('tenant_id', t1.id)).data.length, 1);
    await ctx.close();
  }

  step('isolamento: contas diferentes não veem o rascunho uma da outra');
  const { data: drafts } = await svc.from('onboarding_drafts').select('user_id').in('user_id', users);
  assert.equal(new Set(drafts.map((d) => d.user_id)).size, drafts.length);
  console.log('OK trial-onboarding');
} finally {
  await browser.close();
  // Mantém os dados sintéticos para diagnóstico (prefixo e2e; banco local).
}
