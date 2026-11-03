// App do morador no NAVEGADOR REAL contra Supabase REAL local (dados sintéticos, nenhum envio externo).
// Vazio → chegada → cartão + QR → retirada pela portaria com a tela de QR aberta (fecha o QR) →
// histórico/detalhe/comprovante em processamento → notificação antiga mostra estado atual →
// conta (contatos de outros minimizados) → links antigos → pendente e encerrado →
// matriz 320–1920 sem rolagem horizontal e barra inferior sem encobrir conteúdo.
// Capturas em tests/evidence/morador-*.png (fora do Git).
//
// PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 SUPABASE_URL=... SUPABASE_ANON_KEY=... \
//   SUPABASE_SERVICE_ROLE_KEY=... node tests/e2e/resident-app.mjs
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
const slug = `${run}-morador`;
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
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  step('fixtures: condomínio, unidade A 101 com 2 moradores, porteiro, pedido pendente e acesso encerrado');
  const sindico = await account('sindico', 'Síndica Teste');
  const porteiro = await account('porteiro', 'Porteiro Teste');
  const ana = await account('ana', 'Ana Maria Teste');
  const bruno = await account('bruno', 'Bruno Lima Teste');
  const pend = await account('pend', 'Pessoa Pendente');
  const ex = await account('ex', 'Ex Morador');
  const { tenant_id: T } = await call(sindico, 'provision_tenant', {
    p_request_id: crypto.randomUUID(), p_name: 'Residencial E2E', p_slug: slug, p_document: String(Date.now()).padStart(14, '3').slice(-14),
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly', p_contact_phone: null,
  });
  const { data: unit } = await sindico.client.from('units').insert({ tenant_id: T, block: 'A', label: '101' }).select('id').single();
  const invite = async (who, role, u) => {
    const inv = await call(sindico, 'create_invitation', { p_tenant: T, p_email: who.email, p_role: role, p_unit: u, p_permissions: [] });
    await call(who, 'accept_invitation', { p_token: inv.token });
  };
  await invite(porteiro, 'porteiro', null);
  for (const m of [ana, bruno]) await invite(m, 'morador', unit.id);
  await svc.from('profiles').update({ full_name: 'Ana Maria Teste' }).eq('id', ana.id);
  await svc.from('resident_contacts').update({ phone: '+5511900000002' }).eq('user_id', bruno.id);
  // Autocadastro exige o termo de dados publicado (20261103000100): o síndico cria e publica
  // (a publicação pede login recente — o síndico acabou de entrar) e o morador envia o hash lido.
  const draft = await call(sindico, 'privacy_terms_admin', { p_tenant: T });
  const term = await call(sindico, 'privacy_term_save', { p_tenant: T, p_id: null, p_version: '1.0', p_title: draft.default_title, p_content: draft.default_content, p_note: null });
  await call(sindico, 'privacy_term_publish', { p_tenant: T, p_id: term.id });
  const { hash } = await call(pend, 'privacy_term_current', { p_slug: slug });
  await call(pend, 'request_access', { p_slug: slug, p_full_name: 'Pessoa Pendente', p_phone: '11977770001', p_block: 'A', p_unit: '101', p_privacy_hash: hash });
  // Ex-morador: autocadastro aprovado e depois revogado pela administração (fluxo real).
  await call(ex, 'request_access', { p_slug: slug, p_full_name: 'Ex Morador', p_phone: '11977770002', p_block: 'A', p_unit: '101', p_privacy_hash: hash });
  const [exReq] = await call(sindico, 'list_access_requests', { p_tenant: T, p_status: 'pending' }).then((l) => l.filter((x) => x.full_name === 'Ex Morador'));
  await call(sindico, 'decide_access_request', { p_request: exReq.id, p_approve: true, p_unit: unit.id, p_reason: null });
  const { data: exMem } = await svc.from('tenant_memberships').select('id').eq('tenant_id', T).eq('user_id', ex.id).single();
  await call(sindico, 'set_membership_status', { p_membership: exMem.id, p_status: 'revoked' });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const login = async (p, who, next) => {
    await p.goto(`${APP}/entrar?next=${encodeURIComponent(next)}`);
    await p.getByLabel('E-mail', { exact: true }).fill(who.email);
    await p.getByLabel('Senha', { exact: true }).fill(who.password);
    await p.getByRole('button', { name: 'Entrar' }).click();
  };
  await login(page, ana, `/c/${slug}`);

  step('vazio: saudação com nome, resumo coerente, sem cartão gigante, convite a configurar avisos só se não houver canal');
  await page.waitForURL(/\/inicio$/);
  await page.getByRole('heading', { name: 'Nenhuma encomenda aguardando retirada' }).waitFor();
  await page.getByText(/Ana$|, Ana/).first().waitFor();
  await page.getByText('Suas próximas encomendas aparecerão aqui.').waitFor();
  await page.getByText(/avisamos por e-mail/).waitFor();
  const nav = page.getByRole('navigation', { name: 'Principal' }).last();
  assert.deepEqual((await nav.getByRole('link').allInnerTexts()).map((s) => s.trim()), ['Início', 'Histórico', 'Notificações', 'Minha conta']);
  assert.equal(await page.getByText(/Administração|Configurações|Relatórios|Encomendas$/).count(), 0, 'nada de painel administrativo');
  await page.screenshot({ path: `${evidence}/morador-inicio-vazio-390.png`, fullPage: true });

  step('chegam duas encomendas: contagem, ordem (mais antiga primeiro), rótulos explícitos, sem estante');
  const recv = (key, tracking, carrier) => call(porteiro, 'receive_package', { p_tenant: T, p_idempotency_key: `${run}${key}`, p_unit: unit.id, p_tracking: tracking, p_carrier: carrier });
  const p1 = await recv('k0001', 'BR111', 'Correios');
  await new Promise((r) => setTimeout(r, 1100));
  const p2 = await recv('k0002', 'ML222', 'Mercado Livre');
  await page.reload(); // stack local sem Realtime (docs/STACK_LOCAL.md); em produção a tela atualiza sozinha
  await page.getByRole('heading', { name: 'Você tem 2 encomendas para retirar' }).waitFor({ timeout: 15000 });
  const cards = page.getByRole('list', { name: 'Encomendas para retirar' }).getByRole('listitem');
  assert.match(await cards.nth(0).innerText(), /Correios/);
  assert.match(await cards.nth(0).innerText(), /Chegou em/);
  assert.doesNotMatch(await page.locator('main').innerText(), /Estante|Prateleira/);
  await page.getByRole('link', { name: /Notificações, 2 não lidas/ }).first().waitFor();
  await page.screenshot({ path: `${evidence}/morador-inicio-2-390.png`, fullPage: true });

  step('QR dedicado com unidade e identificação; portaria entrega enquanto a tela está aberta → QR some');
  await cards.nth(0).getByRole('button', { name: 'Mostrar QR de retirada' }).click();
  const sheet = page.getByRole('dialog', { name: 'QR de retirada' });
  await sheet.getByText('Apresente este código à portaria para retirar sua encomenda.').waitFor();
  await sheet.getByText(/Bloco A · 101 · Correios · #/).waitFor();
  await sheet.getByText(/Válido até/).waitFor();
  const box = await sheet.locator('[data-qr] svg').boundingBox();
  assert.ok(box && box.width >= 200 && box.x >= 0 && box.x + box.width <= 390, 'QR inteiro e legível');
  await page.screenshot({ path: `${evidence}/morador-qr-390.png` });
  const sig = `${T}/packages/${p1.id}/signature-${run}a.png`, photo = `${T}/packages/${p1.id}/handover-${run}a.png`;
  for (const pth of [sig, photo]) assert.ifError((await porteiro.client.storage.from('tenant-private').upload(pth, png, { contentType: 'image/png' })).error);
  await call(porteiro, 'deliver_package', { p_tenant: T, p_package: p1.id, p_request: crypto.randomUUID(), p_qr: null, p_picked_up_by: 'Bruno Lima Teste',
    p_recipient_kind: 'morador', p_signature_path: sig, p_item_photo_path: photo, p_manual_reason: 'Teste automatizado: retirada por outro morador' });
  await sheet.getByText('Esta encomenda não está mais aguardando retirada.').waitFor({ timeout: 15000 });
  assert.equal(await sheet.getByText('Apresente este código').count(), 0, 'QR obsoleto não fica na tela');
  await sheet.getByRole('link', { name: 'Ver detalhes' }).click();

  step('detalhe: linha do tempo real, quem retirou, comprovante em processamento (sem botão quebrado)');
  await page.waitForURL(/encomenda\?p=/);
  await page.getByText('Retirada por').waitFor();
  await page.getByText('Chegou na portaria').waitFor();
  await page.getByText(/Comprovante em processamento/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Ver comprovante' }).count(), 0);
  await page.screenshot({ path: `${evidence}/morador-detalhe-390.png`, fullPage: true });

  step('histórico: busca por identificador e drawer de filtros com indicação e Limpar');
  await nav.getByRole('link', { name: 'Histórico' }).click();
  const ref = p1.id.replace(/-/g, '').slice(0, 6).toUpperCase();
  await page.getByText(`#${ref}`).first().waitFor();
  await page.getByLabel('Pesquisar por transportadora, rastreio ou número').fill('mercado');
  await page.getByText('Nada encontrado com essa busca ou filtros.').waitFor();
  await page.getByLabel('Pesquisar por transportadora, rastreio ou número').fill('');
  await page.getByRole('button', { name: /Filtros/ }).click();
  await page.getByRole('dialog', { name: 'Filtros' }).getByLabel('Situação').selectOption('DEVOLVIDA');
  await page.getByRole('button', { name: 'Aplicar' }).click();
  await page.getByRole('button', { name: 'Filtros, 1 ativos' }).waitFor();
  await page.getByText('Nada encontrado com essa busca ou filtros.').waitFor();
  await page.getByRole('button', { name: 'Limpar' }).click();
  await page.getByText(`#${ref}`).first().waitFor();

  step('PDF pronto (worker simulado no banco): botão aparece e abre URL temporária autorizada');
  const { data: rc } = await svc.from('receipts').select('id').eq('package_id', p1.id).single();
  const pdfPath = `${T}/receipts/${p1.id}/comprovante-teste.pdf`;
  assert.ifError((await svc.storage.from('tenant-receipts').upload(pdfPath, Buffer.from('%PDF-1.4\n%%EOF\n'), { contentType: 'application/pdf' })).error);
  await svc.from('receipts').update({ pdf_status: 'ready', pdf_path: pdfPath, pdf_sha256: 'x'.repeat(64), pdf_bytes: 15 }).eq('id', rc.id);
  await page.goto(`${APP}/c/${slug}/encomenda?p=${p1.id}`);
  const dl = page.waitForResponse((r) => r.url().endsWith('/api/receipts/download'));
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Ver comprovante' }).click()]);
  const body = await (await dl).json();
  assert.equal(body.status, 'ready'); assert.match(body.url, /token=/);
  await popup.close();
  await page.getByRole('link', { name: 'Baixar o PDF' }).waitFor(); // alternativa se o visualizador não abrir

  step('notificação antiga de chegada mostra o estado atual; marcar como lida zera o contador do usuário');
  await nav.getByRole('link', { name: /Notificações/ }).click();
  await page.getByText('Situação atual: já foi retirada.').first().waitFor();
  await page.getByRole('link', { name: 'Ver encomenda e QR' }).first().waitFor();
  await page.getByRole('button', { name: 'Marcar todas como lidas' }).click();
  await page.getByRole('link', { name: 'Notificações', exact: true }).first().waitFor();
  const { data: bn } = await svc.from('notifications').select('read_at').eq('user_id', bruno.id).eq('tenant_id', T);
  assert.ok(bn.length > 0 && bn.every((n) => n.read_at === null), 'leitura não afeta outro morador');

  step('Minha conta: outro morador só com primeiro nome; push em linguagem simples; diagnóstico recolhido');
  await nav.getByRole('link', { name: 'Minha conta' }).click();
  await page.getByText('Quem recebe os avisos da unidade').waitFor();
  const unitSec = await page.locator('#unidade').innerText();
  assert.match(unitSec, /Bruno/); assert.doesNotMatch(unitSec, /Lima|900000002|bruno@|e2e\.portariaprime/);
  assert.equal(await page.getByText('Suporte a notificações push').count(), 0);
  await page.locator('#notificacoes').getByText(/Ativar notificações neste dispositivo|não estão disponíveis|não oferece|iPhone|bloqueadas|ativadas/).first().waitFor();
  await page.screenshot({ path: `${evidence}/morador-conta-390.png`, fullPage: true });

  step('links antigos: /morador, /avisos, /aplicativo e /comprovante redirecionam com segurança');
  for (const [from, to] of [['morador', /\/inicio$/], ['avisos', /\/notificacoes$/], ['aplicativo', /\/conta#notificacoes$/], [`comprovante?p=${p1.id}`, /encomenda\?p=/], ['painel', /\/inicio$/]]) {
    await page.goto(`${APP}/c/${slug}/${from}`);
    await page.waitForURL(to);
  }
  await page.goto(`${APP}/c/${slug}/encomenda?p=${crypto.randomUUID()}`);
  await page.getByText('Esta encomenda não foi encontrada ou não está disponível para o seu cadastro.').waitFor();

  step('larguras 320–1920: sem rolagem horizontal; último item visível acima da barra inferior');
  for (const [w, h] of [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024], [820, 1180], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const a of ['inicio', 'historico', 'notificacoes', 'conta']) {
      await page.goto(`${APP}/c/${slug}/${a}`);
      await page.locator('main h1').first().waitFor();
      await page.waitForTimeout(120);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, `rolagem horizontal em ${a} @${w}x${h} (${over}px)`);
      const covered = await page.evaluate(() => {
        const bar = [...document.querySelectorAll('nav[aria-label="Principal"]')].find((n) => n.getBoundingClientRect().height && getComputedStyle(n).position === 'fixed');
        if (!bar) return false;
        scrollTo(0, document.body.scrollHeight);
        const last = [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().height && !e.children.length).pop();
        return last ? last.getBoundingClientRect().bottom > bar.getBoundingClientRect().top + 1 : false;
      });
      assert.ok(!covered, `conteúdo encoberto pela barra em ${a} @${w}x${h}`);
    }
    if ([768, 1280].includes(w)) {
      await page.goto(`${APP}/c/${slug}/inicio`); await page.locator('main h1').first().waitFor();
      await page.screenshot({ path: `${evidence}/morador-inicio-${w}.png`, fullPage: true });
    }
  }

  step('cadastro pendente e acesso encerrado têm telas próprias (não “nenhuma encomenda”)');
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const p2p = await c2.newPage();
  await login(p2p, pend, `/c/${slug}/inicio`);
  await p2p.getByRole('heading', { name: 'Cadastro recebido com sucesso!' }).waitFor();
  await p2p.getByText('Aguardando aprovação').waitFor();
  assert.equal(await p2p.getByText(/Nenhuma encomenda/).count(), 0);
  await p2p.screenshot({ path: `${evidence}/morador-pendente-390.png`, fullPage: true });
  await c2.close();
  const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const p3 = await c3.newPage();
  await login(p3, ex, `/c/${slug}/historico`);
  await p3.getByText(/Seu acesso a este condomínio foi encerrado/).waitFor();
  await p3.screenshot({ path: `${evidence}/morador-encerrado-390.png`, fullPage: true });
  assert.equal(await p3.getByText(/BR111|Correios/).count(), 0, 'sem dados após revogação');
  await c3.close();

  step('outro condomínio/unidade: API e storage negam');
  const { error: e1 } = await ex.client.rpc('resident_package', { p_tenant: T, p_package: p2.id });
  assert.ok(e1);
  const { data: obj } = await ex.client.storage.from('tenant-receipts').createSignedUrl(pdfPath, 60);
  assert.equal(obj, null);

  step('sair limpa a sessão; voltar exige login');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${APP}/c/${slug}/conta`);
  await page.getByRole('button', { name: 'Sair' }).click();
  await page.getByRole('dialog', { name: 'Sair deste aparelho?' }).getByRole('button', { name: 'Sair' }).click();
  await page.waitForURL(/\/entrar/);
  await page.goto(`${APP}/c/${slug}/inicio`);
  await page.waitForURL(/\/entrar\?next=/);

  assert.deepEqual(errors, [], 'sem erros de página');
  console.log('OK resident-app');
} finally {
  await browser.close();
}
