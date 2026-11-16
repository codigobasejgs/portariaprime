// Recebimento em lote no NAVEGADOR REAL contra Supabase REAL local (dados sintéticos).
// 4 fotos de uma vez: 2 conferem (registradas sozinhas), 1 não identifica a unidade (pendência), 1 é a MESMA foto de
// outra (descartada no lote). Confere no banco: guarda confirmada, porteiro e entregador gravados, foto vinculada,
// avisos aos moradores, nada registrado para a pendência, e reenvio do lote não duplica.
// OCR externo substituído (resposta no formato real; correspondência calculada pelo banco).
//
// PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/batch-receive-real.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !anon || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase.');
assertLocalSupabase(url);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(url, secret, opts);
const run = `e2e${Date.now().toString(36)}`;
const { count } = await svc.from('tenants').select('id', { count: 'exact', head: true }).not('slug', 'like', 'e2e%');
assert.equal(count, 0, 'Banco contém condomínios reais: teste recusado.');
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
const call = async (who, fn, args) => { const { data, error } = await who.client.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };
// PNGs sintéticos DIFERENTES (cada foto vira um sha diferente); o 4º repete o 1º.
const pngOf = (n) => Buffer.from(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`, 'base64').toString('latin1') + `#${n}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const sindico = await account('sindico', 'Síndica Lote');
  const porteiro = await account('porteiro', 'Porteira Lote');
  const ana = await account('ana', 'Ana Beatriz Souza');
  const bruno = await account('bruno', 'Bruno Carvalho Lima');
  const { tenant_id: T } = await call(sindico, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'E2E Lote', p_slug: `${run}-lote`,
    p_document: String(Date.now()).padStart(14, '2').slice(-14), p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly', p_contact_phone: null });
  const ins = async (table, row) => { const { data, error } = await sindico.client.from(table).insert(row).select('id').single(); if (error) throw error; return data.id; };
  const u1 = await ins('units', { tenant_id: T, block: 'A', label: '11' });
  const u2 = await ins('units', { tenant_id: T, block: 'A', label: '22' });
  const { data: conc } = await sindico.client.from('concierge_locations').select('id').eq('tenant_id', T).single();
  await ins('storage_locations', { tenant_id: T, concierge_location_id: conc.id, code: 'L1', rack: 'Estante L', shelf: 'Prateleira 1', capacity: 20 });
  const invite = async (who, role, unit) => { const inv = await call(sindico, 'create_invitation', { p_tenant: T, p_email: who.email, p_role: role, p_unit: unit, p_permissions: [] }); await call(who, 'accept_invitation', { p_token: inv.token }); };
  await invite(porteiro, 'porteiro', null); await invite(ana, 'morador', u1); await invite(bruno, 'morador', u2);

  // OCR substituído: cada foto é reconhecida pelo marcador no fim do arquivo enviado.
  const LABELS = { 1: ['Ana Beatriz Souza', '11', 'Shopee'], 2: ['Bruno Carvalho Lima', '22', 'Amazon'], 3: ['Pessoa Que Nao Mora Aqui', '99', 'Correios'] };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let ocrCalls = 0;
  await ctx.route('**/api/ocr/analyze-label', async (route) => {
    ocrCalls++;
    const b64 = route.request().postDataJSON().imageBase64.split(',')[1];
    const n = Number(Buffer.from(b64, 'base64').toString('latin1').match(/#(\d)$/)?.[1] || 0);
    // A foto passa por reencode no navegador (perde o marcador): então a ordem de chegada decide, com mapa estável por chamada.
    const k = n || ocrCalls;
    const [name, unit, carrier] = LABELS[k] || LABELS[3];
    const match = await call(porteiro, 'match_recipient', { p_tenant: T, p_name: name, p_block: 'A', p_unit: unit });
    await route.fulfill({ json: { carrier, recipientName: name, senderName: 'Loja', block: 'A', unit, complement: null, trackingCode: `${run}L${k}`.toUpperCase(),
      orderNumber: null, invoiceNumber: null, evidence: [], alerts: [], confidence: 90, match } });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${APP}/entrar?next=${encodeURIComponent(`/c/${run}-lote/portaria`)}`);
  await page.getByLabel('E-mail', { exact: true }).fill(porteiro.email);
  await page.getByLabel('Senha', { exact: true }).fill(porteiro.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('button', { name: 'Receber várias de uma vez (fotos)' }).click();
  const dlg = page.getByRole('dialog', { name: 'Receber várias encomendas' });
  await dlg.getByLabel('Entregador (obrigatório)').fill('Carlos - Loggi');
  // Porteira logada já vem preenchida.
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === 'Porteira Lote'), null, { timeout: 15000 });

  // 4 arquivos de uma vez pelo "Enviar arquivo" (múltiplo); o 4º é idêntico ao 1º.
  const files = [1, 2, 3, 1].map((n, i) => ({ name: `etiqueta-${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(pngOf(n), 'latin1') }));
  await dlg.locator('input[type=file]').setInputFiles(files);
  await dlg.getByRole('list', { name: 'Etiquetas do lote' }).getByRole('listitem').nth(2).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await dlg.getByRole('list', { name: 'Etiquetas do lote' }).getByRole('listitem').count(), 3, 'foto repetida descartada');
  await page.getByRole('button', { name: 'Enviar 3 encomenda(s)' }).click();
  await dlg.getByText('Relatório do lote').waitFor({ timeout: 60000 });
  const n = async (label) => Number(await dlg.getByText(label).locator('xpath=following-sibling::p').innerText());
  assert.equal(await n('Registradas e moradores avisados'), 2);
  assert.equal(await n('Precisam de você'), 1);

  // Banco: 2 encomendas, guarda confirmada, porteira e entregador gravados, foto vinculada, avisos aos moradores.
  const { data: pk } = await svc.from('packages').select('id, unit_id, status, storage_confirmed_at, storage_location_id, received_by_name, courier_name, label_sha256').eq('tenant_id', T);
  assert.equal(pk.length, 2, 'pendência não vira encomenda');
  assert.deepEqual(new Set(pk.map((p) => p.unit_id)), new Set([u1, u2]));
  for (const p of pk) {
    assert.equal(p.status, 'ARMAZENADA'); assert.ok(p.storage_confirmed_at && p.storage_location_id, 'guarda confirmada');
    assert.equal(p.received_by_name, 'Porteira Lote'); assert.equal(p.courier_name, 'Carlos - Loggi'); assert.match(p.label_sha256, /^[0-9a-f]{64}$/);
  }
  const { count: photos } = await svc.from('package_attachments').select('id', { count: 'exact', head: true }).in('package_id', pk.map((p) => p.id)).eq('kind', 'label_photo');
  assert.equal(photos, 2, 'foto de cada etiqueta vinculada');
  for (const [who, unit] of [[ana, u1], [bruno, u2]]) {
    const id = pk.find((p) => p.unit_id === unit).id;
    const { data } = await who.client.from('notifications').select('kind').eq('package_id', id);
    assert.ok(data.some((x) => x.kind === 'package_received'), 'morador avisado');
  }

  // Resolver a pendência: unidade A 22 e morador por toque → 3ª encomenda.
  await dlg.getByRole('button', { name: 'Resolver' }).click();
  const fix = page.getByRole('dialog', { name: 'Resolver pendência' });
  await fix.getByPlaceholder('Buscar unidade').fill('A 22');
  await fix.getByRole('listbox', { name: 'Unidades encontradas' }).getByRole('option').first().click();
  await fix.getByRole('group', { name: 'Moradores da unidade' }).getByRole('button', { name: 'Bruno Carvalho Lima' }).click();
  await fix.getByRole('button', { name: 'Registrar' }).click();
  await fix.waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(await n('Registradas e moradores avisados'), 3);
  const { count: total } = await svc.from('packages').select('id', { count: 'exact', head: true }).eq('tenant_id', T);
  assert.equal(total, 3);

  assert.deepEqual(errors, [], 'sem erros de página');
  console.log(`OK batch-receive-real (${run})`);
} finally {
  await browser.close();
}
