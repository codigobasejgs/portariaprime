import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReportQuery } from '../src/lib/report-query.ts';

const ctx = {
  today: '2026-11-04',
  blocks: ['A', 'B'],
  units: [{ id: 'u-a204', block: 'A', label: '204' }, { id: 'u-b204', block: 'B', label: '204' }, { id: 'u-a101', block: 'A', label: '101' }, { id: 'u-b12', block: 'B', label: '12' }],
  carriers: ['Correios', 'Mercado Livre', 'Shopee'],
};
const p = (s) => parseReportQuery(s, ctx);

test('exemplos do pedido', () => {
  const a = p('Encomendas pendentes do apartamento 204 do bloco A');
  assert.deepEqual(a.filters, { status: 'PENDENTES', block: 'A', unit: 'u-a204' });
  assert.deepEqual(a.ignored, []);
  const r = p('Ranking das dez unidades que mais receberam encomendas no ano');
  assert.equal(r.ranking, 10);
  assert.deepEqual(r.filters, { received_from: '2026-01-01', received_to: '2026-11-04' });
  const e = p('Relatório executivo anual do condomínio com gráficos');
  assert.deepEqual(e.filters, { received_from: '2026-01-01', received_to: '2026-11-04' });
});

test('unidade ambígua sem bloco não vira filtro (não inventa)', () => {
  const a = p('pendentes do apartamento 204');
  assert.equal(a.filters.unit, undefined);
  assert.ok(a.understood.some((x) => /existe em 2 blocos/.test(x)));
  assert.equal(p('apto 12').filters.unit, 'u-b12', 'única no condomínio');
  assert.equal(p('apto 999').filters.unit, undefined, 'inexistente');
  assert.equal(p('bloco Z').filters.block, undefined, 'bloco inexistente');
});

test('períodos, situação e origem', () => {
  assert.deepEqual(p('retiradas em março').filters, { status: 'RETIRADA', received_from: '2026-03-01', received_to: '2026-03-31' });
  assert.deepEqual(p('encomendas de dezembro').filters, { received_from: '2025-12-01', received_to: '2025-12-31' }, 'mês futuro = ano anterior');
  assert.deepEqual(p('mês passado shopee').filters, { received_from: '2026-10-01', received_to: '2026-10-31', carrier: 'Shopee' });
  assert.deepEqual(p('últimos 7 dias').filters, { received_from: '2026-10-29', received_to: '2026-11-04' });
  assert.deepEqual(p('paradas há mais de 72 horas').filters, { status: 'PENDENTES', received_to: '2026-11-01' });
  assert.equal(p('encomendas do mercado livre em 2025').filters.carrier, 'Mercado Livre');
  assert.deepEqual(p('fevereiro de 2024').filters, { received_from: '2024-02-01', received_to: '2024-02-29' }, 'bissexto');
  assert.deepEqual(p('top 5 apartamentos').ranking, 5);
});

test('texto não entendido é sinalizado, nunca vira filtro', () => {
  const x = p("pendentes '; drop table packages; -- xpto");
  assert.deepEqual(x.filters, { status: 'PENDENTES' });
  assert.ok(x.ignored.includes('drop') && x.ignored.includes('xpto'));
});
