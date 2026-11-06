// E2E da /demonstracao: zero rede externa, fluxo coerente entre perfis, PDF marcado, storage bloqueado.
// Uso: APP=http://127.0.0.1:3017 node tests/e2e/demo-offline.mjs  (precisa de `vite preview` rodando)
import { inflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const ORIGIN = new URL(APP).origin;
const C = `${APP}/c/demonstracao`;
const violations = [], swRequests = [], pageErrors = [], failures = [];
let total = 0;

const step = async (name, fn) => {
  total++;
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${String(e?.message || e).split('\n')[0]}`); }
};
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

// Toda requisição passa aqui: fora da origem local ou em /api é violação (abortada e registrada).
async function guard(ctx) {
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== ORIGIN || /^\/api(\/|$)/.test(u.pathname)) { violations.push(`${route.request().method()} ${u.href}`); return route.abort(); }
    if (/\/sw\.js$|registerSW/.test(u.pathname)) swRequests.push(u.href);
    return route.continue();
  });
}
function watch(page) {
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Motivo de teste' : undefined));
  page.on('pageerror', (e) => pageErrors.push(e.message));
}

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
await guard(ctx);
// Usuário "já autenticado" em produção: sessão Supabase salva e expirada (forçaria refresh no cliente real).
await ctx.addInitScript(() => {
  const s = { access_token: 'eyJhbGciOiJIUzI1NiJ9.e30.x', refresh_token: 'r-ficticio', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 60, user: { id: '11111111-1111-4111-8111-111111111111', email: 'real@exemplo.invalid', aud: 'authenticated', role: 'authenticated' } };
  try { if (!localStorage.getItem('sb-abcdefghijklmnopqrst-auth-token')) localStorage.setItem('sb-abcdefghijklmnopqrst-auth-token', JSON.stringify(s)); } catch { /* ok */ }
});
const page = await ctx.newPage();
watch(page);

const kpi = async () => {
  const card = page.locator('a', { hasText: 'Aguardando retirada agora' });
  await card.waitFor({ timeout: 15000 });
  return Number((await card.locator('p').nth(1).innerText()).replace(/\D/g, ''));
};
const waitingForResident = async () => {
  await page.goto(`${C}/inicio?perfil=morador`);
  const h = page.getByRole('heading', { level: 1, name: /encomenda/ });
  await h.waitFor({ timeout: 15000 });
  const m = (await h.innerText()).match(/(\d+) encomendas?|Nenhuma/);
  return m?.[1] ? Number(m[1]) : (await h.innerText()).includes('1 encomenda') ? 1 : 0;
};
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 10000 });

let kpi0 = 0, res0 = 0;
await step('/demonstracao redireciona para o painel do síndico com a barra', async () => {
  await page.goto(`${APP}/demonstracao`);
  await page.waitForURL(/\/c\/demonstracao\/painel\?perfil=admin/, { timeout: 15000 });
  await page.getByText('Demonstração · dados fictícios').waitFor();
  kpi0 = await kpi();
  check(kpi0 === 6, `KPI inicial esperado 6, veio ${kpi0}`);
});

await step('morador vê as encomendas da própria unidade', async () => {
  res0 = await waitingForResident();
  check(res0 === 2, `esperado 2 aguardando para João Silva (A-101), veio ${res0}`);
});

await step('portaria registra encomenda com etiqueta de exemplo (OCR 92)', async () => {
  await page.goto(`${C}/portaria?perfil=porteiro`);
  await page.getByRole('button', { name: 'Usar etiqueta de exemplo' }).click();
  await page.getByText('Sugestão preenchida').waitFor({ timeout: 15000 });
  check((await page.getByText('Selecionada:').innerText()).includes('101'), 'OCR não selecionou A 101');
  await page.getByLabel('Nome do entregador (obrigatório)').fill('Marcos (Correios)');
  check((await page.getByLabel('Recebido por (porteiro, obrigatório)').inputValue()).length >= 2, 'porteiro não preenchido');
  await page.getByText('Guardei fisicamente em').click();
  await page.getByRole('button', { name: 'Registrar encomenda' }).click();
  await toast('Encomenda registrada para');
});

await step('encomenda nova aparece no morador', async () => {
  const n = await waitingForResident();
  check(n === res0 + 1, `esperado ${res0 + 1}, veio ${n}`);
});

await step('encomenda nova aparece nos indicadores do síndico', async () => {
  await page.goto(`${C}/painel?perfil=admin`);
  const n = await kpi();
  check(n === kpi0 + 1, `esperado ${kpi0 + 1}, veio ${n}`);
});

await step('portaria entrega via QR de exemplo com assinatura e foto', async () => {
  await page.goto(`${C}/portaria?perfil=porteiro&aba=entregar`);
  await page.getByRole('button', { name: 'Usar QR de exemplo' }).click();
  const modal = page.getByRole('dialog', { name: 'Entregar encomenda' });
  await modal.waitFor({ timeout: 10000 });
  await modal.getByText('QR Code válido').waitFor();
  const box = await modal.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 }); await page.mouse.move(box.x + 200, box.y + 30, { steps: 8 }); await page.mouse.up();
  await modal.getByRole('button', { name: 'Usar foto de exemplo' }).click();
  await modal.getByAltText('Foto do item entregue').waitFor();
  await modal.getByRole('button', { name: 'Confirmar entrega' }).click();
  await toast('Entrega registrada. Protocolo DEMO-');
  await page.goto(`${C}/painel?perfil=admin`);
  const n = await kpi();
  check(n === kpi0, `após entrega esperado ${kpi0}, veio ${n}`);
});

await step('PDF do comprovante (morador) gerado localmente e marcado DEMONSTRAÇÃO', async () => {
  await page.goto(`${C}/encomenda?perfil=morador&p=00000000-0000-4000-8000-000000000111`);
  await page.getByRole('button', { name: 'Ver comprovante' }).waitFor({ timeout: 15000 });
  await page.evaluate(() => { window.open = () => (window.__win = { location: {}, opener: 1, close() {} }); });
  await page.getByRole('button', { name: 'Ver comprovante' }).click();
  await page.waitForFunction(() => window.__win?.location?.href, null, { timeout: 15000 });
  const { href, bytes } = await page.evaluate(async () => {
    const href = window.__win.location.href;
    return { href, bytes: Array.from(new Uint8Array(await (await fetch(href)).arrayBuffer())) };
  });
  check(href.startsWith('blob:'), `URL não é blob local: ${href}`);
  const buf = Buffer.from(bytes);
  check(buf.subarray(0, 5).toString() === '%PDF-', 'não é PDF');
  // pdf-lib comprime os streams; descomprime e procura o texto (WinAnsi em hex ou literal).
  let text = buf.toString('latin1');
  for (const m of text.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) { try { text += inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* não-flate */ } }
  const hex = Buffer.from('DEMONSTRAÇÃO', 'latin1').toString('hex').toUpperCase();
  check(text.replace(/\s/g, '').toUpperCase().includes(hex) || text.includes('DEMONSTRAÇÃO'), 'marca DEMONSTRAÇÃO ausente no PDF');
  check(!/\/validar\?|verify/i.test(text.replace(/Comprovante/g, '')), 'PDF contém link de validação');
});

await step('síndico aprova solicitação pendente', async () => {
  await page.goto(`${C}/pessoas?perfil=admin&aba=solicitacoes`);
  const item = page.locator('li', { hasText: 'Gustavo Pereira' });
  await item.waitFor({ timeout: 15000 });
  await item.getByRole('button', { name: 'Aprovar', exact: true }).click();
  await toast('Cadastro aprovado.');
  await page.goto(`${C}/pessoas?perfil=admin&aba=moradores`);
  await page.getByRole('button', { name: 'Ações de Gustavo Pereira' }).waitFor({ timeout: 15000 });
});

await step('síndico edita morador', async () => {
  await page.getByRole('button', { name: 'Ações de Marina Costa' }).click();
  await page.getByRole('menuitem', { name: 'Editar cadastro' }).click();
  const modal = page.getByRole('dialog', { name: 'Editar morador' });
  await modal.getByLabel('Nome').waitFor({ timeout: 10000 });
  await modal.getByLabel('Nome').fill('Marina Costa Souza');
  await modal.getByRole('button', { name: 'Salvar' }).click();
  await toast('Cadastro atualizado.');
  await page.getByRole('button', { name: 'Ações de Marina Costa Souza' }).waitFor({ timeout: 10000 });
});

await step('síndico exclui morador', async () => {
  await page.getByRole('button', { name: 'Ações de Paulo Nogueira' }).click();
  await page.getByRole('menuitem', { name: 'Excluir cadastro' }).click();
  const modal = page.getByRole('dialog', { name: /Excluir Paulo Nogueira/ });
  await modal.getByLabel('Digite EXCLUIR para confirmar').fill('EXCLUIR');
  await modal.getByRole('button', { name: 'Excluir cadastro' }).click();
  await toast('Cadastro excluído.');
  await page.getByRole('button', { name: 'Ações de Paulo Nogueira' }).waitFor({ state: 'detached', timeout: 10000 });
});

for (const [w, h] of [[360, 740], [768, 1024], [1280, 900]]) {
  await step(`barra e página sem scroll horizontal em ${w}px`, async () => {
    await page.setViewportSize({ width: w, height: h });
    for (const path of ['painel?perfil=admin', 'portaria?perfil=porteiro', 'inicio?perfil=morador']) {
      await page.goto(`${C}/${path}`);
      const bar = page.getByRole('region', { name: 'Demonstração' });
      await bar.waitFor({ timeout: 15000 });
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 15000 });
      const r = await page.evaluate(() => {
        const b = document.querySelector('[aria-label="Demonstração"]');
        return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, bar: b.scrollWidth - b.clientWidth, right: b.getBoundingClientRect().right - innerWidth };
      });
      check(r.bar <= 0 && r.right <= 0.5, `${path}: barra transborda (${JSON.stringify(r)})`);
      check(r.doc <= 0, `${path}: página transborda ${r.doc}px`);
    }
  });
}

await step('nenhum service worker nem push registrado', async () => {
  check(ctx.serviceWorkers().length === 0, `service workers ativos: ${ctx.serviceWorkers().length}`);
  check(swRequests.length === 0, `sw solicitado: ${swRequests.join(', ')}`);
  const push = await page.evaluate(async () => ({ perm: typeof Notification === 'undefined' ? 'n/a' : Notification.permission, regs: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0 }));
  check(push.regs === 0, 'registro de SW encontrado');
});
await page.close();
await ctx.close();

// Storage bloqueado (modo privado restrito / cookies de site bloqueados): a demo renderiza em memória.
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await guard(ctx2);
await ctx2.addInitScript(() => {
  for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(window, k, { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
});
const p2 = await ctx2.newPage();
watch(p2);
await step('com storage bloqueado a demonstração renderiza', async () => {
  await p2.goto(`${APP}/demonstracao`);
  await p2.getByText('Demonstração · dados fictícios').waitFor({ timeout: 15000 });
  await p2.locator('a', { hasText: 'Aguardando retirada agora' }).waitFor({ timeout: 15000 });
  check(await p2.evaluate(() => { try { localStorage; return false; } catch { return true; } }), 'storage não estava bloqueado');
});
await ctx2.close();
await browser.close();

await step('zero requisições externas ou /api', async () => check(violations.length === 0, violations.slice(0, 10).join(' | ')));
await step('sem erros de página não tratados', async () => check(pageErrors.length === 0, pageErrors.slice(0, 5).join(' | ')));

console.log(`\n${total - failures.length}/${total} ok${failures.length ? ` — falhas: ${failures.join('; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
