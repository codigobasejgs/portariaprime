// Renderização do comprovante: 3 modelos, logo horizontal/vertical/ausente,
// textos longos e caracteres fora da fonte. Grava amostras em tests/evidence (fora do Git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { renderReceiptPdf } from '../../api/_lib/receipt-pdf.ts';

// PNG sintético (canvas não existe no Node): cria com pdf-lib? Não; usa PNG mínimo válido gerado à mão.
import { deflateSync } from 'node:zlib';
function png(w, h, rgba) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; const [r, g, b, a] = rgba(x, y); raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const wide = png(400, 80, (x) => [16, 31, 48, x % 40 < 20 ? 255 : 0]); // horizontal, transparente
const tall = png(60, 240, (x, y) => [200, 171, 120, 255]);
const sig = png(300, 100, (x, y) => (Math.abs(y - 50 - 30 * Math.sin(x / 20)) < 3 ? [0, 0, 0, 255] : [255, 255, 255, 0]));
const photo = png(320, 240, (x, y) => [x % 256, y % 256, 120, 255]);

const base = {
  protocol: 'PP-20261022-AB12CD34', package_id: '573b1d10-3360-408b-b537-252c1a11d89a', issued_at: '2026-10-22T15:04:00Z',
  recipient_name: 'Fulano de Tal (sintético)',
  snapshot: { tracking_code: 'BR123456789BR', carrier: 'Correios', unit_block: 'A', unit_label: '12B', received_at: '2026-10-22T13:00:00Z',
    picked_up_at: '2026-10-22T15:04:00Z', picked_up_by: 'Pessoa Teste', operator: 'Porteiro Teste', method: 'qr', recipient_kind: 'morador',
    storage: 'Portaria principal › Estante A › Prateleira 2' },
};

test('três modelos geram PDF A4 válido com provas; casos extremos não quebram', async () => {
  mkdirSync('tests/evidence', { recursive: true });
  const long = 'Texto longo com acentuação ção ã é ü e emoji 📦 que não existe na fonte. '.repeat(4);
  const cases = [
    ['classico', { logo: wide }, { color_primary: '#101F30', logo_position: 'left' }],
    ['moderno', { logo: tall }, { color_primary: '#126B61', logo_position: 'center', logo_size: 'large', show_address: true, address: 'Rua Exemplo, 100 — Bairro — Cidade/UF' }],
    ['compacto', { logo: null }, { color_primary: '#F4E4BC', logo_position: 'right', footer: 'Rodapé: ' + 'x'.repeat(190) }],
    ['classico', { logo: wide }, { tenant_name: 'Condomínio Residencial de Nome Muito Comprido Para Testar Quebra de Linha no Cabeçalho', message: long.slice(0, 300), footer: long.slice(0, 200), show_contact: true, contact: '(11) 0000-0000' }],
  ];
  for (const [i, [template, assets, layout]] of cases.entries()) {
    const bytes = await renderReceiptPdf({ ...base, layout: { tenant_name: 'Condomínio Sintético', timezone: 'America/Sao_Paulo', template, ...layout } },
      { ...assets, signature: sig, photo });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
    const doc = await PDFDocument.load(bytes);
    const [w, h] = doc.getPage(0).getSize().width ? [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()] : [0, 0];
    assert.equal(Math.round(w), 595); assert.equal(Math.round(h), 842);
    assert.ok(bytes.length < 2_000_000);
    writeFileSync(`tests/evidence/comprovante-${i}-${template}.pdf`, bytes);
  }
  // Imagem inválida (bytes arbitrários) é ignorada, não derruba a emissão.
  const bad = await renderReceiptPdf({ ...base, layout: {} }, { logo: new Uint8Array([60, 115, 118, 103, 62, 0, 0, 0, 0]), signature: sig, photo });
  assert.ok(bad.length > 1000);
});

test('comprovante novo separa quem recebeu na portaria (e o entregador) de quem entregou ao morador; antigo continua igual', async () => {
  const text = async (snapshot) => {
    const bytes = await renderReceiptPdf({ ...base, snapshot, layout: { template: 'classico', tenant_name: 'Cond' } }, {});
    // pdf-lib grava o texto como hex nas operações Tj; decodifica para procurar os rótulos.
    const raw = Buffer.from(bytes).toString('latin1');
    const { inflateSync } = await import('node:zlib');
    const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => {
      try { return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { return m[1]; }
    }).join('\n');
    return [...streams.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('|');
  };
  const novo = await text({ ...base.snapshot, received_by_name: 'Carlos Porteiro', courier_name: 'João - Mercado Livre', unit_text: 'Quadra B · Lote 15' });
  assert.match(novo, /Recebido na portaria por/);
  assert.match(novo, /Carlos Porteiro \(Entregador: Jo.o - Mercado Livre\)/);
  assert.match(novo, /Entregue ao morador por/);
  assert.match(novo, /Quadra B · Lote 15|Quadra B · Lote 15/);
  const antigo = await text(base.snapshot);
  assert.doesNotMatch(antigo, /Recebido na portaria por/, 'snapshot antigo sem os campos: linha omitida');
  assert.match(antigo, /Bloco A/);
});
