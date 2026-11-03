// Dashboard executivo do síndico no NAVEGADOR REAL contra a pilha LOCAL, com base de encomendas CONHECIDA.
// Confere os números da tela com a definição (recebidas × entregues × coorte), filtros, ranking paginado,
// exportações CSV/XLSX/PDF (conteúdo), isolamento (porteiro não abre; outro condomínio não vê)
// e layout de 320 a 1920 px sem rolagem horizontal.
//   PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/dashboard-executive.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase, fakeCnpj, onboard } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase local.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
const EV = 'tests/evidence';
await mkdir(EV, { recursive: true });
const run = `e2e${Date.now().toString(36)}`;
const slug = `${run}-dash`;
const PASS = 'SenhaForte123!';
const step = (m) => console.log(`• ${m}`);
const sql = (q) => {
  const db = process.env.PP_STACK_DB;
  if (!db || !/@127\.0\.0\.1:/.test(db)) throw new Error('PP_STACK_DB local ausente.');
  // SQL pela entrada padrão em UTF-8: argumento de linha de comando no Windows perde acentos.
  const r = spawnSync(`${process.env.LOCALAPPDATA}/pp-stack/pg17/pgsql/bin/psql.exe`, [db, '-qAt', '-v', 'ON_ERROR_STOP=1'],
    { input: q, encoding: 'utf8', env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
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

  step('síndico cria o condomínio; base conhecida de encomendas (horários relativos a agora)');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const s = await ctx.newPage();
  s.on('pageerror', (e) => errors.push(e.message));
  await login(s, sindico, '/onboarding');
  await s.getByRole('heading', { name: 'Dados do condomínio' }).waitFor();
  await onboard(s, { name: 'Residencial Painel', slug, document: fakeCnpj() });
  await s.waitForURL(new RegExp(`/c/${slug}/`));
  const T = sql(`select id from public.tenants where slug = '${slug}'`).trim();
  const units = sql(`insert into public.units (tenant_id, block, label) values ('${T}','A','101'),('${T}','A','102'),('${T}','B','201') returning id`)
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[0-9a-f-]{36}$/.test(l));
  assert.equal(units.length, 3);
  const [a101, a102, b201] = units;
  // Porteiro do condomínio (para o teste de permissão).
  sql(`insert into public.tenant_memberships (tenant_id, user_id, role, permissions) values ('${T}', '${porteiro.id}', 'porteiro', '{}')`);
  // Base: "ago" em horas antes de agora. Período padrão = últimos 30 dias.
  const P = (unit, ago, status, x = {}) => `('${T}','${unit}','${status}','${x.carrier || 'Correios'}','${crypto.randomUUID()}', now() - interval '${ago} hours',
    ${x.picked != null ? `now() - interval '${x.picked} hours'` : 'null'}, ${x.picked != null ? "'X'" : 'null'}, ${x.picked != null ? "'qr'" : 'null'},
    ${x.notified != null ? `now() - interval '${x.notified} hours'` : 'null'}, ${x.resolved != null ? "'Endereço errado'" : 'null'}, ${x.resolved != null ? `now() - interval '${x.resolved} hours'` : 'null'})`;
  const rows = [
    P(a101, 100, 'RETIRADA', { picked: 98, notified: 99 }),   // recebida e entregue no período (2 h)
    P(a101, 50, 'RETIRADA', { picked: 26, notified: 49 }),    // entregue no período (24 h)
    P(a101, 10, 'ARMAZENADA', { carrier: 'Shopee', notified: 9 }), // aguardando, < 24 h
    P(a102, 80, 'ARMAZENADA'),                                // aguardando, atrasada (> 72 h)
    P(b201, 30, 'DEVOLVIDA', { resolved: 5 }),                // exceção da coorte
    P(b201, 900, 'RETIRADA', { picked: 800 }),                // recebida há 37 dias e entregue há 33: fora dos 30 dias
    P(b201, 5, 'PRE_REGISTRADA'),                             // nunca conta
  ];
  sql(`insert into public.packages (tenant_id, unit_id, status, carrier, idempotency_key, received_at, picked_up_at, picked_up_by_name, pickup_method,
    notified_at, resolution_reason, resolved_at) values ${rows.join(',')}`);
  // Esperado (30 dias): recebidas 5, entregues 2, coorte retirada 2/5 = 40%, aguardando 2, atrasadas 1, unidades movimentadas 3.

  step('aba Análise: números da tela conferem com a definição');
  await s.goto(`${APP}/c/${slug}/painel`);
  await s.getByRole('tab', { name: /Análise/ }).click();
  const kpi = async (label) => (await s.locator('p.text-xs').filter({ hasText: new RegExp('^' + label + '$') }).first().locator('xpath=following-sibling::p[1]').innerText()).trim();
  await s.getByText('Recebidas no período', { exact: true }).first().waitFor();
  const got = {};
  for (const l of ['Recebidas no período', 'Entregues no período', 'Aguardando retirada agora', 'Unidades movimentadas', 'Taxa de retirada']) got[l] = await kpi(l).catch(() => '?');
  console.log('  tela:', JSON.stringify(got));
  const api = await s.evaluate(async ([tenant]) => {
    const { supabase } = await import('/src/lib/supabase.ts');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const from = new Date(Date.parse(today) - 29 * 864e5).toISOString().slice(0, 10);
    const { data, error } = await supabase.rpc('dashboard_executive', { p_tenant: tenant, p_from: from, p_to: today, p_filters: {} });
    return error ? { error: error.message } : data;
  }, [T]);
  assert.ok(!api.error, api.error);
  assert.equal(api.received.value, 5, 'recebidas no período');
  assert.equal(api.delivered.value, 2, 'entregues no período');
  assert.equal(api.cohort.picked, 2);
  assert.equal(api.cohort.rate, 0.4, 'taxa da coorte (não mistura entregas antigas)');
  assert.equal(api.cohort.exceptions, 1);
  assert.equal(api.pending_now, 2);
  assert.equal(api.overdue_now, 1);
  assert.equal(api.units_moved.value, 3);
  assert.equal(api.series.at(-1).balance, api.pending_now, 'saldo final da série = aguardando agora');
  assert.equal(got['Recebidas no período'], '5', 'KPI Recebidas na tela');
  assert.equal(got['Entregues no período'], '2', 'KPI Entregues na tela');
  assert.equal(got['Taxa de retirada'], '40%', 'KPI taxa na tela');
  assert.equal(got['Aguardando retirada agora'], '2');
  await s.screenshot({ path: `${EV}/dash-analise-1440.png`, fullPage: true });

  step('filtro por bloco altera os números; ranking traz as unidades certas');
  const bloco = s.getByLabel('Bloco', { exact: true });
  await bloco.selectOption('A');
  await s.waitForFunction(() => !document.querySelector('[aria-label="Carregando indicadores"]'));
  await s.waitForTimeout(500);
  assert.equal(await kpi('Recebidas no período'), '4', 'bloco A: 4 recebidas');
  const rk = await s.evaluate(async ([tenant]) => {
    const { supabase } = await import('/src/lib/supabase.ts');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const from = new Date(Date.parse(today) - 29 * 864e5).toISOString().slice(0, 10);
    return (await supabase.rpc('dashboard_unit_ranking', { p_tenant: tenant, p_from: from, p_to: today, p_filters: {}, p_limit: 2, p_offset: 0 })).data;
  }, [T]);
  assert.equal(rk.total, 3);
  assert.equal(rk.items.length, 2, 'paginação respeita o limite');
  assert.equal(rk.items[0].unit, '101');
  await bloco.selectOption('');
  await s.waitForTimeout(800);

  step('exportações: CSV, XLSX e PDF com o conteúdo da tela');
  const grab = async (name) => {
    const [dl] = await Promise.all([s.waitForEvent('download'), s.getByRole('button', { name }).click()]);
    const p = `${EV}/dash-export-${run}.${dl.suggestedFilename().split('.').pop()}`;
    await dl.saveAs(p);
    return { name: dl.suggestedFilename(), buf: await readFile(p) };
  };
  const csv = await grab(/^CSV$/);
  const text = csv.buf.toString('utf8');
  assert.ok(text.startsWith('﻿'), 'CSV com BOM');
  assert.match(text, /"Recebidas";"5"/, 'CSV: recebidas = 5');
  assert.match(text, /Ranking de unidades/);
  const x = await grab(/Excel/);
  assert.equal(x.buf.subarray(0, 2).toString(), 'PK', 'XLSX é um zip');
  assert.ok(x.buf.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  const pdf = await grab(/^PDF$/);
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-', 'PDF válido');
  assert.match(csv.name, new RegExp(`^painel-${slug}-\\d{4}-\\d{2}-\\d{2}-a-\\d{4}-\\d{2}-\\d{2}\\.csv$`));

  step('larguras 320–1920 px: sem rolagem horizontal');
  const widths = [320, 360, 375, 390, 414, 768, 1024, 1280, 1440, 1920];
  const over = [];
  for (const w of widths) {
    await s.setViewportSize({ width: w, height: 900 });
    await s.waitForTimeout(250);
    const sw = await s.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (sw > 1) over.push(`${w}px:+${sw}`);
    if (w === 390) await s.screenshot({ path: `${EV}/dash-analise-390.png`, fullPage: true });
  }
  assert.deepEqual(over, [], `rolagem horizontal em ${over.join(', ')}`);

  step('permissões: porteiro não lê o dashboard; outro condomínio recusado');
  const pc = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await pc.auth.signInWithPassword({ email: porteiro.email, password: PASS });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const { error: pe } = await pc.rpc('dashboard_executive', { p_tenant: T, p_from: today, p_to: today, p_filters: {} });
  assert.ok(pe, 'porteiro recusado');
  const outro = sql(`select id from public.tenants where id <> '${T}' limit 1`);
  const { error: oe } = await s.evaluate(async ([tenant, d]) => {
    const { supabase } = await import('/src/lib/supabase.ts');
    return supabase.rpc('dashboard_executive', { p_tenant: tenant, p_from: d, p_to: d, p_filters: {} });
  }, [outro, today]);
  assert.ok(oe, 'síndico de A não lê B');
  const { error: fe } = await s.evaluate(async ([tenant, d]) => {
    const { supabase } = await import('/src/lib/supabase.ts');
    return supabase.rpc('dashboard_executive', { p_tenant: tenant, p_from: d, p_to: d, p_filters: { status: "x'; drop table packages; --" } });
  }, [T, today]);
  assert.match(fe?.message || '', /inválido/, 'filtro malicioso recusado');

  assert.deepEqual(errors, [], `sem erros de JavaScript: ${errors.join(' | ')}`);
  console.log('OK dashboard-executive');
} finally {
  await browser.close();
}
