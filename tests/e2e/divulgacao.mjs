// Central de divulgação no NAVEGADOR REAL contra a pilha LOCAL.
// Síndico abre Portal e aplicativo → escolhe cada modelo → edita e salva → recarrega (persistiu) →
// baixa PNG e PDF → o QR do PNG baixado é lido e leva só ao portal público → mensagem e WhatsApp.
// Porteiro não vê o módulo. Layout de 320 a 1440 px sem rolagem horizontal.
//   PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/divulgacao.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import jsQR from 'jsqr';
import { assertLocalSupabase, fakeCnpj, onboard } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase local.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
const EV = 'tests/evidence';
await mkdir(EV, { recursive: true });
const run = `e2e${Date.now().toString(36)}`;
const slug = `${run}-div`;
const PASS = 'SenhaForte123!';
const step = (m) => console.log(`• ${m}`);
const sql = (q) => {
  const db = process.env.PP_STACK_DB;
  if (!db || !/@127\.0\.0\.1:/.test(db)) throw new Error('PP_STACK_DB local ausente.');
  const r = spawnSync(`${process.env.LOCALAPPDATA}/pp-stack/pg17/pgsql/bin/psql.exe`, [db, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8', env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
async function user(key) {
  const email = `${run}-${key}@e2e.portariaprime.invalid`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error) throw error;
  return { email, id: data.user.id };
}
async function login(page, who, next) {
  await page.goto(`${APP}/entrar?next=${encodeURIComponent(next)}`);
  await page.getByLabel('E-mail').fill(who.email);
  await page.getByLabel('Senha').fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
}
const browser = await chromium.launch();
const errors = [];

try {
  const sindico = await user('sindico');
  const porteiro = await user('porteiro');
  step('síndico cria o condomínio');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const s = await ctx.newPage();
  s.on('pageerror', (e) => errors.push(e.message));
  await login(s, sindico, '/onboarding');
  await s.getByRole('heading', { name: 'Dados do condomínio' }).waitFor();
  await onboard(s, { name: 'Residencial Divulga', slug, document: fakeCnpj() });
  await s.waitForURL(new RegExp(`/c/${slug}/`));
  const T = sql(`select id from public.tenants where slug = '${slug}'`);
  sql(`insert into public.tenant_memberships (tenant_id, user_id, role, permissions) values ('${T}', '${porteiro.id}', 'porteiro', '{}')`);

  step('Configurações → Portal e aplicativo → Divulgação: 4 modelos com prévia');
  await s.goto(`${APP}/c/${slug}/configuracoes?m=portal`);
  await s.getByText('Divulgação do portal').waitFor();
  const preview = s.locator('canvas[role="img"]');
  for (const m of ['Cartaz A4', 'Comunicado A4', 'Elevador (A5)', 'WhatsApp / Instagram']) {
    await s.getByRole('radio', { name: new RegExp(m.replace(/[()/]/g, '.')) }).click();
    await s.getByText(`Pré-visualização — ${m}`).waitFor();
    const size = await preview.evaluate((c) => [c.width, c.height]);
    assert.ok(size[0] >= 800 && size[1] >= 800, `${m}: canvas ${size}`);
  }

  step('editar o cartaz, salvar e recarregar (persistiu no servidor)');
  await s.getByRole('radio', { name: /Cartaz A4/ }).click();
  const title = s.getByLabel('Título', { exact: true });
  await s.getByRole('button', { name: 'Salvar textos' }).and(s.locator(':disabled')).waitFor({ timeout: 5000 });
  await title.fill('Chegou o portal do condomínio!');
  await s.getByRole('button', { name: 'Salvar textos' }).click();
  await s.getByText('Textos salvos.').waitFor();
  await s.reload();
  await s.getByText('Divulgação do portal').waitFor();
  assert.equal(await s.getByLabel('Título', { exact: true }).inputValue(), 'Chegou o portal do condomínio!');
  assert.equal(JSON.parse(sql(`select texts::text from public.portal_divulgacao where tenant_id = '${T}' and model = 'cartaz'`)).title, 'Chegou o portal do condomínio!');
  await s.screenshot({ path: `${EV}/divulgacao-1280.png`, fullPage: true });

  step('baixar PNG: imagem real, QR legível levando só ao portal público');
  const [dlPng] = await Promise.all([s.waitForEvent('download'), s.getByRole('button', { name: 'Baixar PNG' }).click()]);
  assert.equal(dlPng.suggestedFilename(), `divulgacao-${slug}-cartaz.png`);
  const pngPath = `${EV}/divulgacao-${run}.png`;
  await dlPng.saveAs(pngPath);
  const decoded = await s.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: Array.from(g.getImageData(0, 0, img.width, img.height).data) };
  }, (await readFile(pngPath)).toString('base64'));
  assert.deepEqual([decoded.w, decoded.h], [1240, 1754], 'A4 em 150 dpi');
  const qr = jsQR(Uint8ClampedArray.from(decoded.data), decoded.w, decoded.h);
  assert.ok(qr, 'QR do cartaz legível');
  assert.equal(qr.data, `${APP}/c/${slug}`, 'QR = link público do portal');

  step('baixar PDF A4 válido');
  const [dlPdf] = await Promise.all([s.waitForEvent('download'), s.getByRole('button', { name: 'Baixar PDF' }).click()]);
  const pdfPath = `${EV}/divulgacao-${run}.pdf`;
  await dlPdf.saveAs(pdfPath);
  const pdf = await readFile(pdfPath);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const { PDFDocument } = await import('pdf-lib');
  const pages = (await PDFDocument.load(pdf)).getPages();
  assert.equal(pages.length, 1);
  assert.deepEqual([Math.round(pages[0].getWidth()), Math.round(pages[0].getHeight())], [595, 842], 'página A4');

  step('mensagem pronta, copiar e WhatsApp');
  await s.getByRole('button', { name: 'Copiar mensagem' }).click();
  await s.getByText('Mensagem copiada.').waitFor();
  // A área de transferência do Windows troca \n por \r\n; o conteúdo é o mesmo.
  const clip = (await s.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  assert.match(clip, new RegExp(`Acesse: ${APP.replace(/[.]/g, '\\.')}/c/${slug}$`));
  const wa = await s.getByRole('link', { name: 'Enviar pelo WhatsApp' }).getAttribute('href');
  assert.equal(new URL(wa).searchParams.get('text'), clip);

  step('restaurar padrão');
  await s.getByRole('button', { name: 'Restaurar padrão' }).click();
  await s.getByText('Textos padrão restaurados.').waitFor();
  assert.equal(await s.getByLabel('Título', { exact: true }).inputValue(), 'Suas encomendas no celular');

  step('larguras 320–1440 px sem rolagem horizontal');
  const over = [];
  for (const w of [320, 360, 390, 768, 1024, 1440]) {
    await s.setViewportSize({ width: w, height: 900 }); await s.waitForTimeout(250);
    const sw = await s.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (sw > 1) over.push(`${w}px:+${sw}`);
    if (w === 390) await s.screenshot({ path: `${EV}/divulgacao-390.png`, fullPage: true });
  }
  assert.deepEqual(over, [], `rolagem horizontal: ${over.join(', ')}`);

  step('porteiro não vê o módulo e o servidor recusa');
  const p = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(p, porteiro, `/c/${slug}/configuracoes?m=portal`);
  await p.waitForLoadState('networkidle');
  assert.equal(await p.getByText('Divulgação do portal').count(), 0, 'porteiro não vê a divulgação');
  const pc = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await pc.auth.signInWithPassword({ email: porteiro.email, password: PASS });
  assert.match((await pc.rpc('divulgacao_save', { p_tenant: T, p_model: 'cartaz', p_texts: { title: 'invasão' } })).error?.message || '', /Somente/);

  assert.deepEqual(errors, [], `sem erros de JavaScript: ${errors.join(' | ')}`);
  console.log('OK divulgacao');
} finally {
  await browser.close();
}
