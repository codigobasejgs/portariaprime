// Central de divulgação: textos padrão/personalizados, limites, mensagem, quebra de linha,
// contraste e — o principal — o QR leva SÓ o endereço público do portal e decodifica de verdade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { assertPublicLink, cleanTexts, defaults, effective, LIMITS, MODELS, onColor, portalLink, safeColor, shareMessage, whatsappUrl, wrap } from '../src/lib/divulgacao.ts';

test('link público: só /c/{slug}, HTTPS, sem query/hash/credenciais', () => {
  assert.equal(portalLink('https://portariaprime.com.br/', 'village-azaleia'), 'https://portariaprime.com.br/c/village-azaleia');
  assert.equal(assertPublicLink('https://portariaprime.com.br/c/village-azaleia'), 'https://portariaprime.com.br/c/village-azaleia');
  assert.ok(assertPublicLink('http://127.0.0.1:3017/c/abc-def'), 'loopback local permitido para testes');
  for (const bad of ['http://portariaprime.com.br/c/abc', 'https://x.com/c/abc?convite=TOKEN', 'https://x.com/c/abc#t', 'https://u:p@x.com/c/abc',
    'https://x.com/convite?token=abc', 'https://x.com/c/abc/solicitar', 'https://x.com/c/AB']) {
    assert.throws(() => assertPublicLink(bad), /HTTPS|endereço público/, bad);
  }
  // QR por bloco: só ?bloco= com nome de bloco simples; nada além disso.
  assert.equal(portalLink('https://x.com', 'abc', 'Bloco 2'), 'https://x.com/c/abc?bloco=Bloco%202');
  assert.ok(assertPublicLink(portalLink('https://x.com', 'abc', 'Ipê')));
  for (const bad of ['https://x.com/c/abc?bloco=A&convite=1', 'https://x.com/c/abc?bloco=%3Cscript%3E', 'https://x.com/c/abc?bloco=' + 'A'.repeat(31), 'https://x.com/c/abc?bloco=']) {
    assert.throws(() => assertPublicLink(bad), /endereço público/, bad);
  }
});

test('QR decodifica exatamente para o link público', () => {
  const link = 'https://portariaprime.com.br/c/residencial-aurora';
  const qr = QRCode.create(assertPublicLink(link), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size, quiet = 4, cell = 6, W = (n + quiet * 2) * cell;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) {
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const i = (((r + quiet) * cell + y) * W + (c + quiet) * cell + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  const out = jsQR(px, W, W);
  assert.ok(out, 'QR legível');
  assert.equal(out.data, link);
  assert.ok(!/token|convite|senha|password|jwt/i.test(out.data));
});

test('textos: padrão por modelo, personalizado sobrepõe, vazio volta ao padrão, limites e < >', () => {
  for (const m of MODELS) {
    const d = defaults(m.id, 'Residencial Aurora');
    for (const k of Object.keys(LIMITS)) assert.ok(d[k].length > 0 && d[k].length <= LIMITS[k], `${m.id}.${k}`);
  }
  assert.match(defaults('cartaz', 'Residencial Aurora').subtitle, /Residencial Aurora/);
  const e = effective('cartaz', 'Aurora', { title: 'Novidade!', body: '   ' });
  assert.equal(e.title, 'Novidade!');
  assert.equal(e.body, defaults('cartaz', 'Aurora').body, 'vazio usa o padrão');
  const c = cleanTexts({ title: '<script>x</script>'.repeat(20), cta: ' ok ' });
  assert.ok(!/[<>]/.test(c.title));
  assert.ok(c.title.length <= LIMITS.title);
  assert.equal(c.cta, 'ok');
});

test('mensagem pronta e link do WhatsApp', () => {
  const t = defaults('whatsapp', 'Aurora');
  const msg = shareMessage(t, 'Aurora', 'https://portariaprime.com.br/c/aurora');
  assert.match(msg, /Acesse: https:\/\/portariaprime\.com\.br\/c\/aurora$/);
  assert.equal(new URL(whatsappUrl(msg)).searchParams.get('text'), msg);
  assert.equal(new URL(whatsappUrl(msg)).hostname, 'wa.me');
});

test('quebra de linha respeita largura e parágrafos; palavra maior que a linha não some', () => {
  const measure = (s) => s.length * 10;
  const lines = wrap(measure, 'um dois três quatro\ncinco', 100);
  assert.deepEqual(lines, ['um dois', 'três', 'quatro', 'cinco']);
  assert.deepEqual(wrap(measure, 'supercalifragilistico', 50), ['supercalifragilistico']);
});

test('contraste: texto escuro em cor clara, branco em cor escura; cor inválida vira padrão', () => {
  assert.equal(onColor('#FFFFFF'), '#101F30');
  assert.equal(onColor('#F5D76E'), '#101F30');
  assert.equal(onColor('#101F30'), '#FFFFFF');
  assert.equal(safeColor('red; background:url(x)'), '#101F30');
  assert.equal(safeColor('#AbCdEf'), '#AbCdEf');
});
