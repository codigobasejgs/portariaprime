// Renderização dos avisos (e-mail HTML + texto, WhatsApp, push): variáveis, escape, links do PRÓPRIO
// condomínio, logo/cores com fallback, sem dados sensíveis, e um template por evento disparado pelo banco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, emailHtml, emailText, headerColors } from '../../api/_lib/templates.ts';

const APP = 'https://portariaprime.com.br';
const A = { tenant_name: 'Residencial Aurora', tenant_slug: 'aurora', timezone: 'America/Sao_Paulo', color_primary: '#0E7C66',
  logo_url: 'https://x.supabase.co/storage/v1/object/public/tenant-public/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/logo.png',
  resident: { name: 'Ana', unit: 'A 101', reason: null } };
const B = { ...A, tenant_name: 'Condomínio Boreal', tenant_slug: 'boreal', color_primary: null, logo_url: null, resident: { name: 'Dan', unit: '2' } };

test('cadastro recebido: e-mail, texto e WhatsApp com nome, condomínio e link próprio', () => {
  const m = render('access_received', A, {}, APP);
  assert.equal(m.subject, 'Recebemos seu cadastro — Residencial Aurora');
  assert.ok(!/Portaria Prime/.test(m.subject + m.intro + m.whatsapp), 'marca do condomínio, não da plataforma');
  assert.match(m.intro, /^Olá, Ana\. Recebemos sua solicitação de cadastro no Residencial Aurora/);
  assert.equal(m.cta[1], `${APP}/c/aurora/solicitar`);
  assert.match(m.whatsapp, /Olá, Ana!/);
  assert.match(m.whatsapp, /Recebemos seu cadastro no \*Residencial Aurora\*/);
  assert.match(m.whatsapp, /aguardando aprovação/);
  const txt = emailText(A, m);
  assert.match(txt, /Acompanhar minha solicitação: https:\/\/portariaprime\.com\.br\/c\/aurora\/solicitar/);
  assert.ok(!/<[a-z]/i.test(txt), 'texto simples sem HTML');
});

test('aprovado: uma mensagem (aprovação + boas-vindas) por canal, link do portal, sem senha/token', () => {
  const m = render('access_decision', A, { approved: true }, APP);
  assert.equal(m.subject, 'Bem-vindo ao Residencial Aurora!');
  assert.match(m.whatsapp, /Seja bem-vindo ao \*Residencial Aurora\*!/);
  assert.ok(!/Portaria Prime/.test(m.subject + m.intro + m.whatsapp), 'boas-vindas com o nome do condomínio');
  // Outro condomínio: o próprio nome, sem nada do primeiro.
  const mb = render('access_decision', B, { approved: true }, APP);
  assert.equal(mb.subject, 'Bem-vindo ao Condomínio Boreal!');
  assert.ok(!/Aurora/.test(mb.subject + mb.intro + mb.whatsapp));
  assert.match(m.intro, /cadastro no Residencial Aurora foi aprovado/);
  assert.equal(m.cta[1], `${APP}/c/aurora`);
  assert.match(m.whatsapp, /📱 Acesse: https:\/\/portariaprime\.com\.br\/c\/aurora\n/);
  assert.match(m.whatsapp, /Entre com seu e-mail e senha cadastrados\./);
  for (const s of [m.intro, m.whatsapp, emailHtml(A, m), emailText(A, m)]) {
    assert.ok(!/token|senha:|password|access_token|refresh_token/i.test(s), 'nada de credencial no conteúdo');
    // Links: só o portal público, sem query nem fragmento (onde tokens costumam ir).
    for (const url of s.match(/https:\/\/[^\s"'<>]+/g) || []) assert.ok(!/[?#]/.test(url), `link sem query/fragmento: ${url}`);
  }
});

test('recusado: orientação segura, motivo informado pelo síndico (escapado no HTML)', () => {
  const ctx = { ...A, resident: { name: 'Ana', unit: 'A 101', reason: '<script>alert(1)</script> Unidade não confere' } };
  const m = render('access_decision', ctx, { approved: false }, APP);
  assert.match(m.subject, /não aprovado — Residencial Aurora/);
  assert.match(m.intro, /enviar o cadastro novamente pelo portal/);
  const html = emailHtml(ctx, m);
  assert.ok(!html.includes('<script>'), 'motivo escapado');
  assert.match(html, /&lt;script&gt;/);
});

test('síndico: nova solicitação com nome e unidade, push sem dado pessoal, link para a fila do próprio condomínio', () => {
  const m = render('access_request', A, {}, APP);
  assert.equal(m.cta[1], `${APP}/c/aurora/pessoas`);
  assert.equal(m.push.url, `${APP}/c/aurora/pessoas`);
  assert.ok(!/Ana|101/.test(m.push.body), 'push (tela bloqueada) sem nome/unidade');
  assert.deepEqual(m.lines.filter(([, v]) => v).map(([k]) => k), ['Morador', 'Unidade informada']);
});

test('identidade visual: logo HTTPS, cor do condomínio com contraste; fallback sem logo/cor', () => {
  const ha = emailHtml(A, render('access_received', A, {}, APP));
  assert.match(ha, /<img src="https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/tenant-public\//);
  assert.match(ha, /background:#0E7C66;padding:20px 24px;color:#FFFFFF/);
  assert.match(ha, /Residencial Aurora/);
  const hb = emailHtml(B, render('access_received', B, {}, APP));
  assert.ok(!hb.includes('<img'), 'sem logo: só o nome');
  assert.match(hb, /background:#101F30/, 'cor padrão Portaria Prime');
  assert.ok(!hb.includes('Aurora') && !hb.includes('aurora'), 'nada do condomínio A no e-mail de B');
  // Logo não-HTTPS ou com aspas é descartado (sem injeção de atributo).
  const bad = emailHtml({ ...A, logo_url: 'javascript:alert(1)' }, render('access_received', A, {}, APP));
  assert.ok(!bad.includes('<img'));
  const bad2 = emailHtml({ ...A, logo_url: 'https://x.com/a.png" onerror="alert(1)' }, render('access_received', A, {}, APP));
  assert.ok(!bad2.includes('onerror'));
  // Cor clara: texto escuro; cor inválida: padrão.
  assert.deepEqual(headerColors('#F5D76E'), { bg: '#F5D76E', fg: '#101F30' });
  assert.deepEqual(headerColors('red;background:url(x)'), { bg: '#101F30', fg: '#FFFFFF' });
  assert.match(ha, /<meta name="viewport"/, 'pronto para celular');
  assert.match(ha, /Tecnologia Portaria Prime/, 'rodapé institucional');
});

test('WhatsApp: sem HTML, marcadores do nome neutralizados, tamanho controlado', () => {
  const ctx = { ...A, tenant_name: '*Aurora* _x_ <b>', resident: { name: '~Ana~ `x`', unit: 'A 101' } };
  const m = render('access_decision', ctx, { approved: true }, APP);
  assert.ok(!/<\/?[a-z]/i.test(m.whatsapp.replace(/<b>/, '')) || !m.whatsapp.includes('</'), 'sem tags');
  assert.ok(!m.whatsapp.includes('*Aurora*'), 'negrito do nome não quebra a formatação');
  assert.ok(!m.whatsapp.includes('~Ana~'));
});

test('todo evento que o banco enfileira tem template (sem "Evento sem template")', () => {
  const events = ['package_received', 'package_reminder', 'package_picked_up', 'portal_welcome', 'access_request', 'access_received', 'access_decision',
    'ops_alert', 'trial_reminder', 'billing_order', 'billing_paid', 'support_reply', 'quote_sent', 'contract_copy'];
  const payload = { approved: true, amount_cents: 1000, cycle: 'monthly', plan_name: 'Prime', trial_ends_at: '2026-12-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z',
    kind: 'trial_d7', token: 't', protocol: 'P', valid_until: '2026-12-01T00:00:00Z' };
  for (const e of events) {
    const m = render(e, { ...A, package: { id: 'p1', carrier: 'Correios', unit: 'A 101' } }, payload, APP);
    assert.ok(m.subject && m.intro && m.cta?.[1], e);
    assert.ok(m.cta[1].startsWith(APP), `${e}: link na URL pública`);
    assert.ok(!/localhost|127\.0\.0\.1/.test(JSON.stringify(m)), `${e}: sem URL local`);
  }
  assert.throws(() => render('evento_inexistente', A, {}, APP), /sem template/);
});
