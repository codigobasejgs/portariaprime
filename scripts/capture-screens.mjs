// Capturas REAIS para landing, tutoriais e ajuda: navegador de verdade, stack Supabase local isolada.
// Fixtures criadas pelas mesmas RPCs do app (com usuários comuns), telas atuais.
// Dados 100% fictícios (domínio .invalid); QR desfocado (não utilizável); assinatura e fotos sintéticas.
// Nenhum envio externo: a stack local não tem Resend/WhatsApp e o worker não é chamado.
// Originais PNG em tests/evidence/screens (fora do Git); WebP em public/screens. Manifesto: docs/SCREENSHOTS_MANIFEST.md.
//
//   node scripts/local-stack.mjs up
//   npm run dev:stack
//   node --env-file=.env.stack.local scripts/capture-screens.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { assertLocalSupabase } from '../tests/e2e/environment.mjs';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
assertLocalSupabase(url);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(url, secret, opts);
const run = Date.now().toString(36);
const raw = 'tests/evidence/screens';
const out = 'public/screens';
await mkdir(raw, { recursive: true });
await mkdir(out, { recursive: true });
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const manifest = [];
const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime', 'sob-medida']);

async function account(key, name) {
  const email = `demo-${run}-${key}@demo.portariaprime.invalid`;
  const password = `D${crypto.randomUUID()}!`;
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  const client = createClient(url, anon, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  await svc.from('profiles').update({ full_name: name }).eq('id', data.user.id);
  return { email, password, id: data.user.id, client };
}
const call = async (who, fn, args) => {
  const { data, error } = await who.client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};

/** Condomínio fictício completo: marca, locais, unidades, equipe e moradores (pelas RPCs reais). */
async function tenant({ name, slug, color, accent, doc, sindico, porteiro, moradores }) {
  const { tenant_id: T } = await call(sindico, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: name, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'profissional', p_cycle: 'monthly', p_contact_phone: null });
  await svc.from('tenant_branding').upsert({ tenant_id: T, display_name: name, color_primary: color, color_secondary: color, color_accent: accent });
  const { data: conc } = await sindico.client.from('concierge_locations').select('id').eq('tenant_id', T).single();
  await sindico.client.from('concierge_locations').update({ name: 'Portaria principal' }).eq('id', conc.id);
  const locs = {};
  for (const [code, rack, shelf, cap] of [['A-1', 'Estante A', 'Prateleira 1', 12], ['A-2', 'Estante A', 'Prateleira 2', 12], ['VOL', 'Sala de volumes', null, 6]]) {
    const { data, error } = await sindico.client.from('storage_locations').insert({ tenant_id: T, concierge_location_id: conc.id, code, rack, shelf, capacity: cap }).select('id').single();
    if (error) throw error; locs[code] = data.id;
  }
  const units = {};
  for (const [b, l] of [['A', '101'], ['A', '102'], ['A', '201'], ['B', '101'], ['B', '305']]) {
    const { data, error } = await sindico.client.from('units').insert({ tenant_id: T, block: b, label: l }).select('id').single();
    if (error) throw error; units[`${b} ${l}`] = data.id;
  }
  const invite = async (who, role, unit) => {
    const inv = await call(sindico, 'create_invitation', { p_tenant: T, p_email: who.email, p_role: role, p_unit: unit, p_permissions: [] });
    await call(who, 'accept_invitation', { p_token: inv.token });
  };
  if (porteiro) await invite(porteiro, 'porteiro', null);
  for (const [who, unit] of moradores) await invite(who, 'morador', units[unit]);
  return { T, slug, locs, units };
}
async function receive(who, t, unit, carrier, tracking, recipient, loc = 'A-1') {
  return call(who, 'receive_and_store', { p_tenant: t.T, p_idempotency_key: `cap-${crypto.randomUUID()}`, p_unit: t.units[unit],
    p_tracking: tracking, p_carrier: carrier, p_courier: 'Entregador Teste', p_recipient: recipient, p_notes: null, p_storage_location: t.locs[loc] });
}
async function deliver(who, t, pkg, by) {
  const sig = `${t.T}/packages/${pkg}/signature-cap${run}.png`, photo = `${t.T}/packages/${pkg}/handover-cap${run}.png`;
  for (const p of [sig, photo]) { const { error } = await who.client.storage.from('tenant-private').upload(p, png1, { contentType: 'image/png' }); if (error) throw error; }
  return call(who, 'deliver_package', { p_tenant: t.T, p_package: pkg, p_request: crypto.randomUUID(), p_qr: null, p_picked_up_by: by,
    p_recipient_kind: 'morador', p_signature_path: sig, p_item_photo_path: photo, p_manual_reason: 'Demonstração: documento conferido na portaria' });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = (vp, mobile = false) => browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
async function login(page, who, next) {
  await page.goto(`${APP}/entrar${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.getByLabel('E-mail', { exact: true }).fill(who.email);
  await page.getByLabel('Senha', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/app|\/c\//);
  // Sem ofertas de tutorial nas capturas.
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pp_tour')) localStorage.removeItem(k); });
}
async function shot(page, name, route, scenario, blur = []) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  await page.addStyleTag({ content: 'main > div:has(> a[href*="ajuda?artigo"]):has(button) { display: none !important; } div[aria-live="polite"].fixed { display: none !important; }' });
  await page.waitForTimeout(250);
  const png = await page.screenshot({ fullPage: false });
  let img = sharp(png);
  if (blur.length) {
    const meta = await img.metadata();
    const overlays = [];
    for (const sel of blur) {
      const b = await page.locator(sel).first().boundingBox();
      if (!b) throw new Error(`Desfoque obrigatório sem alvo: ${sel}`);
      const left = Math.max(0, Math.round(b.x)), top = Math.max(0, Math.round(b.y));
      const width = Math.min(meta.width - left, Math.round(b.width)), height = Math.min(meta.height - top, Math.round(b.height));
      overlays.push({ input: await sharp(png).extract({ left, top, width, height }).blur(24).toBuffer(), left, top });
    }
    img = sharp(await img.composite(overlays).png().toBuffer());
  }
  const final = await img.png().toBuffer();
  await writeFile(`${raw}/${name}.png`, final);
  await sharp(final).webp({ quality: 82 }).toFile(`${out}/${name}.webp`);
  const vp = page.viewportSize();
  if (vp.width > 720) await sharp(final).resize(720).webp({ quality: 80 }).toFile(`${out}/${name}-720.webp`);
  manifest.push({ file: `public/screens/${name}.webp`, route, viewport: `${vp.width}x${vp.height}`, scenario });
  console.log(`• ${name}`);
}

try {
  const sindA = await account('sindica-aurora', 'Helena Aurora (fictícia)');
  const port = await account('porteiro-aurora', 'Rafael Portaria (fictício)');
  const mor = await account('moradora-aurora', 'Marina Costa (fictícia)');
  const mor2 = await account('morador2-aurora', 'Paulo Costa (fictício)');
  const sindB = await account('sindico-jardim', 'Otávio Jardim (fictício)');
  const A = await tenant({ name: 'Residencial Aurora', slug: `e2e-aurora-${run}`, color: '#1F3A5F', accent: '#C8AB78', doc: String(11_000_000_000_000 + (Date.now() % 9_000_000_000)),
    sindico: sindA, porteiro: port, moradores: [[mor, 'A 101'], [mor2, 'A 101']] });
  const B = await tenant({ name: 'Condomínio Jardim das Palmeiras', slug: `e2e-jardim-${run}`, color: '#126B61', accent: '#E3C27A', doc: String(22_000_000_000_000 + (Date.now() % 9_000_000_000)),
    sindico: sindB, porteiro: null, moradores: [] });

  // Operação fictícia: 9 entradas, 2 retiradas, uma parada há mais de 72 h.
  const items = [['A 101', 'Correios', 'Marina Costa'], ['A 101', 'Mercado Livre', 'Paulo Costa'], ['A 102', 'Amazon', 'Carlos Demo'], ['A 201', 'Shopee', 'Ana Demo'],
    ['B 101', 'Loggi', 'Bruno Demo'], ['B 305', 'Correios', 'Paula Demo'], ['A 102', 'Correios', 'Carlos Demo'], ['A 201', 'Mercado Livre', 'Ana Demo'], ['B 101', 'Amazon', 'Bruno Demo']];
  const pk = [];
  for (const [i, [u, c, r]] of items.entries()) pk.push(await receive(port, A, u, c, `DEMO${i}${run.toUpperCase()}BR`, r, i % 3 === 0 ? 'A-2' : 'A-1'));
  await svc.from('packages').update({ received_at: new Date(Date.now() - 80 * 3600_000).toISOString() }).eq('id', pk[5].id);
  await deliver(port, A, pk[2].id, 'Carlos Demo');
  await deliver(port, A, pk[4].id, 'Bruno Demo');
  await receive(sindB, B, 'A 101', 'Correios', `DEMOB${run.toUpperCase()}BR`, 'Morador Jardim');

  // Síndico: Visão geral (Operação e Análise), ocupação, plano e marcas.
  const dS = await ctx({ width: 1440, height: 900 });
  const s = await dS.newPage();
  await login(s, sindA, `/c/${A.slug}/painel`);
  await s.goto(`${APP}/c/${A.slug}/painel?aba=operacao`);
  await s.getByText('Aguardando retirada agora').waitFor();
  await shot(s, 'painel-desktop', '/c/:slug/painel (Operação)', 'Visão geral: 9 entradas, 2 retiradas, 1 encomenda acima de 72 h');
  await s.locator('[data-tour="painel-ocupacao"]').scrollIntoViewIfNeeded();
  await s.evaluate(() => scrollBy(0, -120));
  await shot(s, 'armazenamento-desktop', '/c/:slug/painel (ocupação)', 'Ocupação por local de guarda');
  await s.goto(`${APP}/c/${A.slug}/configuracoes?m=plano`);
  await s.getByText(/Mês grátis/).first().waitFor();
  await shot(s, 'assinatura-desktop', '/c/:slug/configuracoes?m=plano', 'Mês grátis ativo com início, fim e plano escolhido');
  await s.goto(`${APP}/c/${A.slug}/portaria?aba=buscar`);
  await s.getByRole('heading', { name: 'Encomendas' }).waitFor();
  await shot(s, 'marca-a-desktop', '/c/:slug/portaria', 'Condomínio A com marca azul');
  const dB = await ctx({ width: 1440, height: 900 });
  const sb = await dB.newPage();
  await login(sb, sindB, `/c/${B.slug}/portaria`);
  await sb.goto(`${APP}/c/${B.slug}/portaria?aba=buscar`);
  await sb.getByRole('heading', { name: 'Encomendas' }).waitFor();
  await shot(sb, 'marca-b-desktop', '/c/:slug/portaria', 'Condomínio B com marca verde; dados separados de A');

  // Portaria: recebimento preenchido (antes de salvar), entrega e comprovante, celular.
  const dP = await ctx({ width: 1440, height: 900 });
  const p = await dP.newPage();
  await login(p, port, `/c/${A.slug}/portaria`);
  await p.goto(`${APP}/c/${A.slug}/portaria`);
  await p.getByRole('button', { name: 'Receber encomenda' }).click();
  await p.getByLabel('Nome do entregador (obrigatório)').fill('Carlos - Mercado Livre');
  await p.getByLabel('Transportadora').selectOption('Mercado Livre');
  await p.getByRole('button', { name: 'Avançar', exact: true }).click();
  await p.getByLabel(/Unidade de destino/).fill('A 201');
  await p.getByRole('listbox', { name: 'Unidades encontradas' }).getByRole('option').first().click();
  await p.getByLabel(/Rastreio/).fill('DEMO-ML-8841');
  await p.getByLabel(/Destinatário/).fill('Ana Demo');
  await shot(p, 'recebimento-desktop', '/c/:slug/portaria', 'Recebimento preenchido, antes de salvar (sem etiqueta real)');
  await p.goto(`${APP}/c/${A.slug}/portaria?aba=buscar`);
  await p.getByRole('button', { name: 'Entregar', exact: true }).first().click();
  await p.getByLabel('Quem está retirando').fill('Marina Costa');
  await p.getByRole('button', { name: 'Avançar', exact: true }).click();
  await p.getByLabel('Justificativa').fill('Demonstração: documento conferido na portaria');
  await p.getByRole('button', { name: 'Avançar', exact: true }).click();
  await p.locator('canvas').scrollIntoViewIfNeeded();
  const box = await p.locator('canvas').boundingBox();
  await p.mouse.move(box.x + 30, box.y + 60); await p.mouse.down();
  await p.mouse.move(box.x + 120, box.y + 30, { steps: 10 }); await p.mouse.move(box.x + 200, box.y + 80, { steps: 10 }); await p.mouse.move(box.x + 280, box.y + 40, { steps: 10 });
  await p.mouse.up();
  await p.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'item.png', mimeType: 'image/png', buffer: png1 });
  await p.getByAltText('Foto do item entregue').waitFor();
  await p.getByRole('button', { name: 'Confirmar entrega' }).click();
  await p.getByRole('button', { name: 'Ver comprovante' }).click();
  await p.getByRole('dialog', { name: 'Comprovante de retirada' }).getByText('Retirada por').waitFor();
  await shot(p, 'comprovante-desktop', '/c/:slug/portaria (comprovante)', 'Comprovante após retirada com assinatura e foto sintéticas (código de verificação desfocado)', ['[data-verify-code]']);
  const mP = await ctx({ width: 390, height: 844 }, true);
  const pm = await mP.newPage();
  await login(pm, port, `/c/${A.slug}/portaria`);
  await pm.goto(`${APP}/c/${A.slug}/portaria?aba=buscar`);
  await pm.getByRole('heading', { name: 'Encomendas' }).waitFor();
  await shot(pm, 'portaria-mobile', '/c/:slug/portaria (Buscar)', 'Portaria no celular: aguardando retirada');

  // Morador: Início com encomendas e QR desfocado.
  const mM = await ctx({ width: 390, height: 844 }, true);
  const m = await mM.newPage();
  await login(m, mor, `/c/${A.slug}/inicio`);
  await m.goto(`${APP}/c/${A.slug}/inicio`);
  await m.getByRole('heading', { name: /Você tem \d+ encomenda/ }).waitFor();
  await shot(m, 'morador-mobile', '/c/:slug/inicio', 'App do morador: encomendas aguardando retirada');
  await m.getByRole('button', { name: 'Mostrar QR de retirada' }).first().click();
  await m.getByText('Apresente este código à portaria para retirar sua encomenda.').waitFor();
  await shot(m, 'morador-qr-mobile', '/c/:slug/inicio (QR)', 'QR de retirada (desfocado na captura; não utilizável)', ['[data-qr]']);

  await sharp(`${raw}/painel-desktop.png`).resize(1200, 630, { fit: 'cover', position: 'top' }).png({ compressionLevel: 9 }).toFile(`${out}/og.png`);

  const date = new Date().toISOString().slice(0, 10);
  const md = ['# Manifesto de capturas', '',
    `Geradas por \`scripts/capture-screens.mjs\` em ${date}, a partir do commit \`${commit}\` (mais alterações locais não commitadas), na stack Supabase local isolada, com Edge headless, tema claro e movimento reduzido.`,
    'Dados 100% fictícios (domínio `.invalid`). Nenhum envio externo. QR desfocado; assinatura e fotos sintéticas; tokens existem apenas na stack local.', '',
    '| Arquivo | Rota | Viewport | Cenário |', '|---|---|---|---|',
    ...manifest.map((x) => `| \`${x.file}\` | \`${x.route}\` | ${x.viewport} | ${x.scenario} |`), '| `public/screens/og.png` | derivada de painel-desktop | 1200x630 | Imagem Open Graph |', '',
    'Recapturar: `node scripts/local-stack.mjs up`, `npm run dev:stack` e `node --env-file=.env.stack.local scripts/capture-screens.mjs`.', ''];
  await writeFile('docs/SCREENSHOTS_MANIFEST.md', md.join('\n'));
  console.log(`PASS ${manifest.length} capturas.`);
} catch (e) {
  for (const c of browser.contexts()) for (const pg of c.pages()) await pg.screenshot({ path: `${raw}/falha-${browser.contexts().indexOf(c)}-${c.pages().indexOf(pg)}.png` }).catch(() => {});
  throw e;
} finally {
  await browser.close();
}
