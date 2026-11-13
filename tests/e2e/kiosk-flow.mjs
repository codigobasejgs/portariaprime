// Laboratório: fluxo operacional COMPLETO dentro da WebView do quiosque no emulador (Device Owner, Lock Task):
// foto da etiqueta pela câmera → registro com guarda confirmada → morador gera QR → porteiro lê o QR pela câmera
// → quem retira + assinatura no canvas → foto do item → confirma → comprovante + PDF.
// Câmera: o emulador headless não fornece câmera (cr_VideoCapture: "unknown device 0"); a permissão CAMERA está
// concedida e fixada pelo DPC (dumpsys: granted=true, POLICY_FIXED). Por isso o vídeo do getUserMedia é substituído
// por um canvas com a etiqueta/QR/item — o leitor jsQR, o recorte, o upload e as RPCs são os reais do app.
// A câmera física fica para a homologação no aparelho. OCR: sem chave Gemini na stack local (ver resultado impresso).
//
//   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
//   PP_E2E_ALLOW=1 node --env-file=.env.stack.local tests/e2e/kiosk-flow.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1') throw new Error('Defina PP_E2E_ALLOW=1.');
assertLocalSupabase(url);
const lab = JSON.parse(readFileSync('tests/evidence/kiosk-lab.json', 'utf8'));
const svc = createClient(url, secret, { auth: { persistSession: false } });
const ADB = process.env.ADB || 'J:/android-toolchain/sdk/platform-tools/adb.exe';
const lock = () => execFileSync(ADB, ['shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' }).match(/mLockTaskModeState=(\w+)/)[1];
const save = (n) => writeFileSync(`tests/evidence/emu-${n}.png`, execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64e6 }));
const step = (s) => console.log(`- ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find((t) => t.type === 'page' && t.url.startsWith('http'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  for (let i = 0; i < 20; i++) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (!r.error && !r.result?.exceptionDetails) return r.result.result.value;
    if (r.result?.exceptionDetails && i === 19) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    await sleep(500);
  }
}
const path = () => ev('location.pathname');
async function waitFor(fn, ms = 25000, what = '') { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(400); } throw new Error(`tempo esgotado: ${what}`); }
const hasText = (t) => ev(`document.body.innerText.includes(${JSON.stringify(t)})`);
const setInput = (label, v) => ev(`(() => {
  const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}));
  const el = lab ? (document.getElementById(lab.htmlFor) || lab.querySelector('input,textarea')) : document.querySelector(${JSON.stringify(label)});
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const click = (sel, text) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}) && !e.disabled); if (!el) return false; el.click(); return true; })()`);
// Substitui o vídeo da câmera por um canvas com a imagem pedida (etiqueta, QR ou item).
const fakeCamera = (dataUrl) => ev(`(() => { window.__ppImg = ${JSON.stringify(dataUrl)};
  if (!window.__ppPatched) { window.__ppPatched = true; const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => {
      const cv = document.createElement('canvas'); cv.width = 800; cv.height = 800; void orig; const g = cv.getContext('2d'); const im = new Image(); im.src = window.__ppImg;
      await im.decode(); const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 800, 800); g.drawImage(im, 100, 100, 600, 600); }; draw(); setInterval(draw, 100);
      return cv.captureStream(10); }; }
  return true; })()`);
const svgUrl = (lines) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#fff"/>${
  lines.map((l, i) => `<text x="30" y="${80 + i * 60}" font-family="Arial" font-size="40">${l}</text>`).join('')}</svg>`).toString('base64');

// --- Preparação: porteiro logado no quiosque -------------------------------------
const run = Date.now().toString(36).toUpperCase();
step('porteiro entra no quiosque');
await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('sb-')) localStorage.removeItem(k); location.href = '/entrar?next=' + encodeURIComponent('/c/${lab.slug}/portaria'); return true; })()`);
await waitFor(() => ev(`!!document.querySelector('input[type=email]')`), 25000, 'login');
await setInput('input[type=email]', lab.porteiro.email); await setInput('input[type=password]', lab.porteiro.password);
await click('button', 'Entrar');
await waitFor(async () => /\/portaria$/.test(await path()), 25000, 'portaria');
await waitFor(() => hasText('Receber encomenda'), 25000, 'tela de encomendas');
assert.equal(lock(), 'LOCKED');

step('etiqueta pela câmera da WebView (permissão concedida pelo DPC)');
// Passo a passo: etapa 1 (entregador) antes da etiqueta.
assert.ok(await click('button', 'Receber encomenda'), 'abre o recebimento');
await waitFor(() => hasText('Etapa 1 de 3'), 10000, 'etapa do entregador');
await setInput('Nome do entregador', 'Entregador Lab - Correios');
assert.ok(await click('[role=dialog] button', 'Avançar'));
await waitFor(() => hasText('Etapa 2 de 3'), 10000, 'etapa da encomenda');
await fakeCamera(svgUrl(['DESTINATÁRIO:', 'MARIA MORADORA LAB', 'BLOCO A APTO 101', 'CORREIOS - SEDEX', `OBJETO: ${run}BR`]));
assert.ok(await click('button', 'Fotografar etiqueta') || await click('button', 'Escanear etiqueta'), 'botão da câmera');
await waitFor(() => ev(`(document.querySelector('video')?.videoWidth || 0) > 0`), 15000, 'vídeo da câmera com imagem');
await sleep(800);
assert.ok(await click('button', 'Capturar'));
await waitFor(() => ev(`!!document.querySelector('img[alt="Foto da etiqueta"]')`), 15000, 'foto na galeria');
// OCR real (Gemini) dispara sozinho com a primeira foto; aguarda o resultado ou o aviso de falha.
await waitFor(async () => !(await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Ler etiqueta') && b.disabled)`)), 60000, 'OCR terminar').catch(() => {});
await sleep(1500);
const ocrOut = await ev(`({ fields: document.querySelector('[aria-label="Campos lidos"]')?.innerText || null,
  match: [...document.querySelectorAll('[role=alert]')].map(e => e.textContent).join(' | ').slice(0, 300),
  unit: [...document.querySelectorAll('input')].map(i => i.value).filter(Boolean).join(' / ') })`);
console.log(`   OCR: ${JSON.stringify(ocrOut).slice(0, 600)}`);
save('20-etiqueta');

step('registro: unidade, rastreio, destinatário, guarda física confirmada');
// Morador e unidade: se o OCR já casou a unidade, mantém; senão o porteiro escolhe (confirmação humana).
if (!(await hasText('Selecionada: Bloco A · 101'))) {
  await setInput('Unidade de destino', 'A 101');
  await waitFor(() => ev(`!!document.querySelector('[role=listbox] button, [role=option]')`), 10000, 'unidade');
  await ev(`(() => { const b = [...document.querySelectorAll('[role=listbox] button, [role=option]')].find((x) => x.textContent.includes('101')); b.click(); return true; })()`);
}
await waitFor(() => hasText('Selecionada: Bloco A · 101'), 10000, 'unidade confirmada');
await setInput('Rastreio', `${run}BR`);
await setInput('Destinatário', 'Maria Moradora Lab');
await ev(`(() => { const s = document.querySelector('select'); if (s && [...s.options].some(o => o.value)) { s.value = [...s.options].find(o => o.value).value; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
await click('button', 'Salvar e avançar'); await sleep(800);
await ev(`(() => { const c = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Guardei fisicamente'))?.querySelector('input'); if (c && !c.checked) c.click(); return true; })()`);
await click('button', 'Salvar e avançar');
await waitFor(() => hasText('Moradores da unidade avisados'), 30000, 'registro confirmado');
save('21-registrada');
assert.ok(await click('button', 'Encerrar recebimento'));
await waitFor(() => hasText('Resumo do recebimento'), 10000, 'resumo');
assert.ok(await click('button', 'Finalizar'));
const { data: pkg } = await svc.from('packages').select('id, status, storage_confirmed_at').eq('tenant_id', lab.tenant).eq('tracking_code', `${run}BR`).single();
assert.ok(pkg.storage_confirmed_at, 'guarda confirmada');
const { count: labelPhotos } = await svc.from('package_attachments').select('id', { count: 'exact', head: true }).eq('package_id', pkg.id).eq('kind', 'label_photo');
assert.ok(labelPhotos >= 1, 'foto da etiqueta enviada do quiosque');

step('morador gera o QR de retirada (app do morador, fora do quiosque)');
const mc = createClient(url, anon, { auth: { persistSession: false } });
await mc.auth.signInWithPassword({ email: lab.morador.email, password: lab.morador.password });
const { data: tok, error: te } = await mc.rpc('issue_pickup_token', { p_tenant: lab.tenant, p_package: pkg.id });
if (te) throw te;

step('porteiro lê o QR pela câmera do quiosque');
await fakeCamera(await QRCode.toDataURL(tok.token, { margin: 4, width: 600 }));
await click('button', 'Entregar ao morador');
await waitFor(() => hasText('Ler QR Code do morador'), 10000, 'aba entregar');
await click('button', 'Ler QR Code do morador');
await waitFor(() => hasText('QR Code válido para esta encomenda'), 30000, 'QR lido e validado');
save('22-qr-lido');

step('quem retira, assinatura no canvas, foto do item e confirmação');
await setInput('Quem está retirando', 'Maria Moradora Lab');
assert.ok(await click('[role=dialog] button', 'Avançar'));
await waitFor(() => hasText('Etapa 2 de 3'), 10000, 'encomendas da unidade');
assert.ok(await click('[role=dialog] button', 'Avançar'));
await waitFor(() => hasText('Etapa 3 de 3'), 10000, 'confirmação');
// Assinatura com eventos de ponteiro reais no canvas do SignaturePad.
await ev(`document.querySelector('[role=dialog] canvas').scrollIntoView({ block: 'center' }); true`);
await sleep(500);
const box = await ev(`(() => { const c = document.querySelector('[role=dialog] canvas'); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const dpr = await ev('devicePixelRatio');
for (const [type, fx, fy] of [['mousePressed', 0.1, 0.5], ['mouseMoved', 0.3, 0.2], ['mouseMoved', 0.5, 0.8], ['mouseMoved', 0.8, 0.3], ['mouseReleased', 0.8, 0.3]]) {
  await cdp('Input.dispatchMouseEvent', { type, x: box.x + box.w * fx, y: box.y + box.h * fy, button: 'left', clickCount: 1 });
  await sleep(60);
}
void dpr;
assert.ok(await ev(`(() => { const c = document.querySelector('[role=dialog] canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 200; })()`), 'traço da assinatura no canvas');
await fakeCamera(svgUrl(['CAIXA ENTREGUE', `${run}BR`]));
await click('[role=dialog] button', 'Fotografar item entregue');
await waitFor(() => ev(`(document.querySelector('[role=dialog] video')?.videoWidth || 0) > 0`), 15000, 'câmera do item com imagem');
await sleep(800);
await click('[role=dialog] button', 'Capturar');
await waitFor(() => ev(`!!document.querySelector('img[alt="Foto do item entregue"]')`), 15000, 'foto do item');
save('23-assinatura-foto');
await waitFor(() => ev(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.includes('Confirmar entrega') && !b.disabled)`), 10000, 'botão habilitado (assinatura + foto)');
await click('[role=dialog] button', 'Confirmar entrega');
await waitFor(() => hasText('Protocolo PP-'), 30000, 'resumo da entrega');
assert.ok(await click('[role=dialog] button', 'Ver comprovante'));
await waitFor(() => hasText('Retirada por'), 30000, 'comprovante');
save('24-comprovante');
const { data: rc } = await svc.from('receipts').select('protocol, snapshot').eq('package_id', pkg.id).single();
assert.match(rc.protocol, /^PP-/);
assert.equal(rc.snapshot.method, 'qr', 'retirada por QR');
assert.ok(rc.snapshot.signature_path && rc.snapshot.handover_path, 'assinatura e foto no comprovante');
const { data: p2 } = await svc.from('packages').select('status').eq('id', pkg.id).single();
assert.equal(p2.status, 'RETIRADA');
const { count: notes } = await svc.from('notifications').select('id', { count: 'exact', head: true }).eq('package_id', pkg.id);
console.log(`   protocolo ${rc.protocol}; avisos ao morador: ${notes}`);
assert.equal(lock(), 'LOCKED', 'continua no quiosque');

step('histórico: a entrega aparece na busca da portaria');
await ev(`[...document.querySelectorAll('[role=dialog] button[aria-label="Fechar"]')].reverse().forEach((b) => b.click()); true`);
await click('[role=tab]', 'Histórico');
await sleep(800);
await ev(`(() => { const i = [...document.querySelectorAll('input')].find((x) => x.placeholder === 'Rastreio, unidade ou nome'); if (!i) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '${run}BR'); i.dispatchEvent(new Event('input', { bubbles: true })); i.form?.requestSubmit(); return true; })()`);
await waitFor(() => hasText(`${run}BR`), 15000, 'histórico com a encomenda');
assert.ok(await ev(`document.body.innerText.includes('Retirada') || document.body.innerText.includes('RETIRADA') || document.body.innerText.includes('Entregue')`), 'status de retirada no histórico');
save('26-historico');

step('notificações: o que foi pedido, aceito pelo provedor e confirmado');
const { data: jobs } = await svc.from('notification_jobs').select('event, channel, status, attempts, last_error, recipient').eq('ref_id', pkg.id).order('created_at');
console.log(JSON.stringify(jobs));
console.log('OK kiosk-flow');
ws.close();
