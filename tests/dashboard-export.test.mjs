// Dashboard do síndico: períodos no fuso, insights com base numérica, CSV (BOM + ;), XLSX (zip stored + CRC32) e PDF com acentos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as crc32as } from 'node:zlib';
import { crc32, xlsx } from '../src/lib/xlsx.ts';
import { presetRange, rangeError, todayIn, insights, exportTables, exportCsv, exportName } from '../src/lib/dashboard.ts';
import { dashboardPdf, winAnsi } from '../src/lib/dashboard-pdf.ts';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Leitor de zip independente do gerador (pelo diretório central); exige método 0 (stored).
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  assert.ok(e >= 0, 'fim do diretório central');
  const out = {};
  for (let i = 0, p = v.getUint32(e + 16, true); i < v.getUint16(e + 10, true); i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    assert.equal(v.getUint16(p + 10, true), 0, 'stored');
    const crc = v.getUint32(p + 16, true), size = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), off = v.getUint32(p + 42, true);
    assert.equal(v.getUint32(off, true), 0x04034b50, 'cabeçalho local');
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    out[new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen))] = { crc, data: bytes.subarray(start, start + size) };
    p += 46 + nlen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}

test('CRC32 confere com o valor de referência', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('XLSX: zip válido, partes obrigatórias, texto escapado e números como número', () => {
  const bytes = xlsx([{ name: 'Indicadores', rows: [['Situação', 'Valor'], ['Recebidas <&>', 12], ['=cmd()', null]] }, { name: 'a/b', rows: [] }]);
  const files = unzip(bytes);
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
  for (const f of Object.values(files)) assert.equal(f.crc, crc32as(f.data), 'CRC de cada parte');
  const s1 = new TextDecoder().decode(files['xl/worksheets/sheet1.xml'].data);
  assert.match(s1, /<t xml:space="preserve">Situação<\/t>/);
  assert.match(s1, /Recebidas &lt;&amp;&gt;/);
  assert.match(s1, /<c r="B2"><v>12<\/v><\/c>/);
  assert.match(s1, /<c r="A3" t="inlineStr">.*=cmd\(\)/, 'texto inline, nunca fórmula');
  assert.doesNotMatch(s1, /<f>/);
  assert.match(new TextDecoder().decode(files['xl/workbook.xml'].data), /name="a b"/, 'nome de aba sem caracteres proibidos');
});

test('atalhos de período no fuso do condomínio', () => {
  // 03/11/2026 01:00Z ainda é 02/11 em São Paulo.
  assert.equal(todayIn('America/Sao_Paulo', new Date('2026-11-03T01:00:00Z')), '2026-11-02');
  const t = '2026-11-03';
  assert.deepEqual(presetRange('hoje', t), { from: t, to: t });
  assert.deepEqual(presetRange('ontem', t), { from: '2026-11-02', to: '2026-11-02' });
  assert.deepEqual(presetRange('7', t), { from: '2026-10-28', to: t });
  assert.deepEqual(presetRange('30', t), { from: '2026-10-05', to: t });
  assert.deepEqual(presetRange('mes', t), { from: '2026-11-01', to: t });
  assert.deepEqual(presetRange('mes_ant', t), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(presetRange('tri', t), { from: '2026-10-01', to: t });
  assert.deepEqual(presetRange('tri_ant', t), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(presetRange('sem', t), { from: '2026-07-01', to: t });
  assert.deepEqual(presetRange('sem_ant', t), { from: '2026-01-01', to: '2026-06-30' });
  assert.deepEqual(presetRange('ano', t), { from: '2026-01-01', to: t });
  assert.deepEqual(presetRange('ano_ant', t), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(presetRange('mes_ant', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' }, 'virada de ano');
  assert.deepEqual(presetRange('tri_ant', '2026-02-10'), { from: '2025-10-01', to: '2025-12-31' });
  assert.equal(rangeError('2024-01-01', '2024-12-31'), null, 'ano bissexto completo cabe');
  assert.match(rangeError('2025-01-01', '2026-01-03'), /1 ano/);
  assert.match(rangeError('2026-02-01', '2026-01-01'), /anterior/);
});

const sample = {
  from: '2026-03-09', to: '2026-03-10', previous: { from: '2026-03-07', to: '2026-03-08' }, filters: { block: 'B' }, options: { units: [] },
  received: { value: 10, previous: 8, change: 0.25 }, delivered: { value: 4, previous: 2, change: 1 }, units_moved: { value: 6, previous: 4, change: 0.5 },
  cohort: { received: 10, picked: 3, exceptions: 0, rate: 0.3 }, pending_now: 7, overdue_now: 2, overdue_hours: 72,
  pickup_time: { n: 4, avg_h: 30.5, median_h: 26, avg_h_previous: 20, change: 0.525 },
  efficiency: { within_24h: 0.25, within_48h: 0.5, within_48h_previous: 1, receipt_to_notice: { median_h: 0.2 }, notice_to_pickup: { median_h: 25 } },
  heatmap: [{ dow: 2, hour: 14, n: 5 }, { dow: 3, hour: 9, n: 3 }, { dow: 2, hour: 10, n: 2 }],
  blocks: [{ block: 'B', received: 7, pending: 5 }, { block: 'A', received: 3, pending: 2 }],
  concentration: { top_units: 5, top_received: 9, total_received: 10 },
  series: [{ start: '2026-03-09', end: '2026-03-09', received: 6, delivered: 2, balance: 9 }, { start: '2026-03-10', end: '2026-03-10', received: 4, delivered: 2, balance: 7 }],
};

test('insights determinísticos com o número que os fundamenta', () => {
  const by = Object.fromEntries(insights(sample).map((i) => [i.id, i]));
  assert.match(by.growth.text, /cresceram 25%/); assert.equal(by.growth.basis, '8 → 10 encomendas');
  assert.match(by.block.text, /bloco B concentra 70%/); assert.equal(by.block.basis, '7 de 10');
  assert.equal(by.late.tone, 'warning'); assert.equal(by.late.basis, '0% → 50% das entregas');
  assert.match(by.peak.text, /terça-feira; horário de pico entre 14h e 15h/); assert.match(by.peak.basis, /^7 recebidas no dia · 5 no horário$/);
  assert.match(by.units.text, /5 unidades concentram 90%/);
  assert.match(by.overdue.basis, /2 de 7/);
  for (const i of insights(sample)) assert.doesNotMatch(i.text, /prev|vai|será|tendência/i, 'sem previsão');
  const flat = insights({ ...sample, received: { value: 0, previous: 0, change: null }, heatmap: [], blocks: [], overdue_now: 0,
    efficiency: { within_48h: null }, concentration: { top_units: 0, top_received: 0, total_received: 0 } });
  assert.deepEqual(flat, [], 'sem dados, sem insight');
});

test('CSV: BOM UTF-8, separador ;, seções da tela e fórmulas neutralizadas', () => {
  const tables = exportTables(sample, [{ block: 'B', unit: '=201', received: 7, delivered: 2, pending: 5, share: 0.7, change: null, avg_pickup_h: 12.5 }], 'Condomínio Ipê');
  const csv = exportCsv(tables);
  assert.ok(csv.startsWith('﻿"Indicadores"'));
  assert.equal(csv.match(/﻿/g).length, 1, 'um único BOM');
  assert.match(csv, /"Recebidas";"10";"8";"25,0%"/);
  assert.match(csv, /"Filtros";"Bloco B"/);
  assert.match(csv, /"1";"B";"'=201";"7"/);
  assert.match(csv, /"Série"\r\n"Início";"Fim";"Recebidas";"Entregues";"Saldo pendente no fim"\r\n"09\/03\/2026";"09\/03\/2026";"6";"2";"9"/);
  assert.equal(exportName('ipe-cond', '2026-03-09', '2026-03-10', 'csv'), 'painel-ipe-cond-2026-03-09-a-2026-03-10.csv');
});

test('PDF: Helvetica WinAnsi aceita "ç ã é" e troca o que não cabe', async () => {
  const tables = exportTables(sample, [], 'Condomínio São José');
  const bytes = await dashboardPdf('Painel — Condomínio São José', ['Período: ç ã é → ≤ 72 h', 'Emoji 📦 vira ?'], tables);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), 'Painel - Condomínio São José');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  assert.equal(winAnsi('ç ã é Ç Ã É º ª õ ü', font), 'ç ã é Ç Ã É º ª õ ü', 'acentos do português ficam');
  assert.equal(winAnsi('→ ≤ 📦', font), '-> <= ?');
  assert.doesNotThrow(() => font.encodeText('ç ã é'), 'Helvetica WinAnsi codifica');
});
