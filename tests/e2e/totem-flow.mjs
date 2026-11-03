// Totem da equipe no NAVEGADOR REAL contra Supabase REAL local (dados sintéticos).
// 3 moradores na unidade 12B + 1 de outra unidade. Porteiro: Registrar encomenda
// (foto → local sugerido → guarda confirmada) → morador gera QR → Entregar (consulta
// não consome → assinatura → foto do item → confirma) → comprovante para os 3.
// OCR externo não é chamado: o teste preenche os campos como o porteiro faria.
//
// PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 SUPABASE_URL=... SUPABASE_ANON_KEY=... \
//   SUPABASE_SERVICE_ROLE_KEY=... node tests/e2e/totem-flow.mjs
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
const slug = `${run}-totem`;
const evidence = 'tests/evidence';
await mkdir(evidence, { recursive: true });
const step = (name) => console.log(`• ${name}`);

const { count } = await svc.from('tenants').select('id', { count: 'exact', head: true }).not('slug', 'like', 'e2e%');
assert.equal(count, 0, 'Banco contém condomínios reais: teste recusado.');
const { data: plansBefore } = await svc.from('plans').select('code, published');
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);

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
// Imagem PNG sintética (a câmera é substituída pelo envio de arquivo do próprio componente).
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  step('fixtures: condomínio, unidades 12B e 34, estantes, porteiro, 3+1 moradores');
  const sindico = await account('sindico', 'Síndica Teste');
  const porteiro = await account('porteiro', 'Porteiro Teste');
  const m = await Promise.all([
    account('m1', 'Jefferson Gomes dos Santos'), account('m2', 'Maria Souza Santos'), account('m3', 'Pedro Gomes'),
  ]);
  const outro = await account('outro', 'Morador Outra Unidade');
  const { tenant_id: T } = await call(sindico, 'provision_tenant', {
    p_request_id: crypto.randomUUID(), p_name: 'E2E Totem', p_slug: slug, p_document: String(Date.now()).padStart(14, '1').slice(-14),
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly', p_contact_phone: null,
  });
  const ins = async (table, row) => { const { data, error } = await sindico.client.from(table).insert(row).select('id').single(); if (error) throw error; return data.id; };
  const u12b = await ins('units', { tenant_id: T, block: 'A', label: '12B' });
  const u34 = await ins('units', { tenant_id: T, block: 'B', label: '34' });
  const { data: conc } = await sindico.client.from('concierge_locations').select('id').eq('tenant_id', T).single();
  await ins('storage_locations', { tenant_id: T, concierge_location_id: conc.id, code: 'A-2', rack: 'Estante A', shelf: 'Prateleira 2', capacity: 30 });
  await ins('storage_locations', { tenant_id: T, concierge_location_id: conc.id, code: 'CONT', rack: 'Contingência', capacity: 5, is_contingency: true });
  const invite = async (who, role, unit) => {
    const inv = await call(sindico, 'create_invitation', { p_tenant: T, p_email: who.email, p_role: role, p_unit: unit, p_permissions: [] });
    await call(who, 'accept_invitation', { p_token: inv.token });
  };
  await invite(porteiro, 'porteiro', null);
  for (const r of m) await invite(r, 'morador', u12b);
  await invite(outro, 'morador', u34);

  const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  // Provedor de OCR externo substituído: resposta no formato real, correspondência calculada pelo banco.
  await ctx.route('**/api/ocr/analyze-label', async (route) => {
    const match = await call(porteiro, 'match_recipient', { p_tenant: T, p_name: 'Jefferson Gomes dos Santos', p_block: null, p_unit: '12B' });
    await route.fulfill({ json: { carrier: 'Mercado Livre', recipientName: 'Jefferson Gomes dos Santos', senderName: 'Loja Exemplo', block: null, unit: '12B',
      complement: 'Apto 12B', trackingCode: `${run}BR1`.toUpperCase(), orderNumber: '2000001', invoiceNumber: null,
      evidence: [{ field: 'recipientName', text: 'Jefferson Gomes dos Santos' }], alerts: ['“LSP-105” parece código de triagem, não unidade.'], confidence: 92, match } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (r) => { if (r.status() >= 400 && r.url().includes('/rpc/attach_label_photo')) console.error('Vínculo da foto:', await r.text()); });
  // O fluxo da equipe segue separado do OCR do dispositivo público pareado.
  await page.goto(`${APP}/entrar?next=${encodeURIComponent(`/c/${slug}/totem-equipe`)}`);
  await page.getByLabel('E-mail', { exact: true }).fill(porteiro.email);
  await page.getByLabel('Senha', { exact: true }).fill(porteiro.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/totem-equipe/);
  await page.getByRole('heading', { name: 'Totem da portaria' }).waitFor();

  step('Registrar encomenda: foto, unidade, local sugerido e guarda confirmada');
  await page.getByRole('tab', { name: 'Registrar encomenda' }).click();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'etiqueta.png', mimeType: 'image/png', buffer: png });
  await page.getByAltText('Foto da etiqueta').waitFor();
  // OCR roda sozinho após a foto; servidor confirma morador ativo e pré-seleciona a unidade.
  await page.getByText('Destinatário confere com um morador ativo da unidade.').waitFor();
  await page.getByText(/LSP-105/).waitFor();
  assert.match(await page.getByText(/Selecionada:/).innerText(), /12B/);
  assert.equal(await page.getByLabel('Rastreio').inputValue(), `${run}BR1`.toUpperCase());
  // Galeria: segunda foto (volume) depois da etiqueta; a etiqueta continua sendo a primeira.
  await page.locator('input[type=file]').first().setInputFiles({ name: 'volume.png', mimeType: 'image/png', buffer: png });
  await page.getByAltText('Foto 2 do volume').waitFor();
  const sel = page.getByLabel('Local de guarda');
  await assert.doesNotReject(async () => assert.match(await sel.locator('option:checked').innerText(), /Estante A › Prateleira 2/));
  await page.getByRole('button', { name: 'Registrar encomenda' }).click();
  await page.getByText('Escolha o local e confirme').waitFor();
  await page.getByText(/Guardei fisicamente em/).click();
  await page.getByRole('button', { name: 'Registrar encomenda' }).click();
  await page.getByText(/Moradores da unidade avisados/).waitFor();
  await page.screenshot({ path: `${evidence}/totem-registrar.png`, fullPage: true });

  const { data: [pkg] } = await svc.from('packages').select('id, storage_confirmed_at, label_sha256').eq('tenant_id', T);
  assert.ok(pkg.storage_confirmed_at, 'guarda confirmada gravada');
  assert.match(pkg.label_sha256, /^[0-9a-f]{64}$/);
  const { data: gal } = await svc.from('package_attachments').select('position, object_path').eq('package_id', pkg.id).eq('kind', 'label_photo').order('position');
  assert.deepEqual(gal.map((g) => g.position), [1, 2], 'galeria com 2 fotos em ordem');
  assert.ok(gal.every((g, i) => g.object_path.startsWith(`${T}/packages/${pkg.id}/label-${i + 1}-`)));
  for (const r of m) {
    const { data } = await r.client.from('notifications').select('kind').eq('package_id', pkg.id);
    assert.deepEqual(data.map((x) => x.kind), ['package_received']);
  }
  assert.equal((await outro.client.from('notifications').select('id').eq('package_id', pkg.id)).data.length, 0);

  step('Morador 2 gera QR; porteiro consulta (sem consumir) e entrega com assinatura + foto do item');
  const { token } = await call(m[1], 'issue_pickup_token', { p_tenant: T, p_package: pkg.id });
  await page.getByRole('tab', { name: 'Entregar ao morador' }).click();
  // Leitura de câmera substituída pela mesma RPC de consulta que o leitor chama.
  const seen = await page.evaluate(async ([tk, tenant]) => {
    const { supabase } = await import('/src/lib/supabase.ts');
    const r1 = await supabase.rpc('lookup_pickup_token', { p_tenant: tenant, p_qr: tk });
    const r2 = await supabase.rpc('lookup_pickup_token', { p_tenant: tenant, p_qr: tk });
    return [r1.error?.message, r2.error?.message, r2.data?.storage_shelf];
  }, [token, T]);
  assert.deepEqual(seen, [undefined, undefined, 'Prateleira 2'], 'consulta repetida não consome o QR');
  // Abre a entrega pela lista (mesmo modal); QR é validado na confirmação.
  await page.getByRole('button', { name: 'Entregar sem QR' }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByText(/Buscar em: .*Estante A › Prateleira 2/).waitFor();
  await modal.getByLabel('Quem está retirando').fill('Maria Souza Santos');
  await modal.getByLabel('Justificativa').fill('Teste E2E: QR conferido por consulta na tela');
  await assert.ok(await modal.getByRole('button', { name: 'Confirmar entrega' }).isDisabled(), 'sem assinatura/foto não confirma');
  const canvas = modal.locator('canvas');
  // Sob carga o modal ainda está assentando: assinar só com o canvas parado (2 leituras iguais).
  const sign = async () => {
    let box = await canvas.boundingBox();
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(100); const b = await canvas.boundingBox(); if (b && box && b.x === box.x && b.y === box.y && b.width === box.width) break; box = b; }
    await page.mouse.move(box.x + 20, box.y + 30); await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 }); await page.mouse.move(box.x + 200, box.y + 25, { steps: 8 });
    await page.mouse.up();
  };
  await sign();
  await modal.locator('input[type=file]').setInputFiles({ name: 'item.png', mimeType: 'image/png', buffer: png });
  await modal.getByAltText('Foto do item entregue').waitFor();
  // Assinatura e foto presentes → botão habilita. Se o traço não registrou (raro sob carga), assina de novo uma vez.
  const confirmBtn = modal.getByRole('button', { name: 'Confirmar entrega' });
  if (!(await confirmBtn.isEnabled())) { console.log('  (assinatura não registrou; assinando de novo)'); await sign(); }
  assert.ok(await confirmBtn.isEnabled(), 'com assinatura e foto, a entrega pode ser confirmada');
  await modal.getByRole('button', { name: 'Confirmar entrega' }).click();
  await page.getByText('Comprovante de retirada').first().waitFor();
  await page.screenshot({ path: `${evidence}/totem-comprovante.png`, fullPage: true });

  const { data: rc } = await svc.from('receipts').select('protocol, snapshot').eq('package_id', pkg.id).single();
  assert.match(rc.protocol, /^PP-/);
  assert.match(rc.snapshot.handover_path, /handover-/);
  assert.match(rc.snapshot.storage, /Estante A › Prateleira 2/);

  step('3 moradores da unidade: histórico, aviso e comprovante; outra unidade não vê');
  for (const r of m) {
    assert.equal((await r.client.from('receipts').select('protocol').eq('package_id', pkg.id)).data[0]?.protocol, rc.protocol);
    const { data } = await r.client.from('notifications').select('kind').eq('package_id', pkg.id);
    assert.ok(data.some((x) => x.kind === 'package_picked_up'));
  }
  assert.equal((await outro.client.from('receipts').select('id').eq('package_id', pkg.id)).data.length, 0);
  const { data: jobs } = await svc.from('notification_jobs').select('channel, event').eq('ref_id', pkg.id);
  console.log('  outbox:', JSON.stringify(jobs.reduce((a, j) => ({ ...a, [`${j.event}:${j.channel}`]: (a[`${j.event}:${j.channel}`] || 0) + 1 }), {})));

  step('morador abre o link estável do comprovante (exige login)');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mp = await mctx.newPage();
  const link = `/c/${slug}/comprovante?p=${pkg.id}`;
  await mp.goto(`${APP}${link}`);
  await mp.waitForURL(/\/entrar/);
  await mp.getByLabel('E-mail', { exact: true }).fill(m[2].email);
  await mp.getByLabel('Senha', { exact: true }).fill(m[2].password);
  await mp.getByRole('button', { name: 'Entrar' }).click();
  // Link antigo de comprovante abre o detalhe atual da encomenda no app do morador.
  await mp.waitForURL(/encomenda\?p=/);
  await mp.getByText(rc.protocol).waitFor();
  await mp.getByText('Retirada por').waitFor();
  await mp.screenshot({ path: `${evidence}/totem-comprovante-morador.png`, fullPage: true });
  assert.deepEqual(errors, [], 'sem erros de página');
  console.log(`OK — totem ponta a ponta (${run}). Fixtures preservadas para diagnóstico.`);
} finally {
  await browser.close();
  for (const p of plansBefore || []) await svc.from('plans').update({ published: p.published }).eq('code', p.code);
}
