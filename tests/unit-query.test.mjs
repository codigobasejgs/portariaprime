import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnitQuery, unitScore, unitCode, textMatches, distinctBlocks } from '../src/lib/unit-query.ts';

const units = [
  { id: '1a-3', block: '1A', label: '3' }, { id: '1a-11', block: '1A', label: '11' }, { id: '1a-31', block: '01A', label: '31' },
  { id: '10b-22', block: '10B', label: '22' }, { id: '15b-22', block: '15B', label: '22' }, { id: '15b-220', block: '15B', label: '220' },
  { id: '1-101', block: '1', label: '101' }, { id: 'q3', block: 'Quadra 3', label: 'Lote 10' },
];
const find = (q) => units.filter((u) => unitScore(u, q) > 0).sort((a, b) => unitScore(b, q) - unitScore(a, q)).map((u) => u.id);

test('formas combinadas de bloco + número', () => {
  for (const q of ['15B-22', '15B 22', '15b/22', 'bloco 15B apto 22', '15B, nº 22']) assert.equal(find(q)[0], '15b-22', q);
  assert.deepEqual(find('15B-22'), ['15b-22', '15b-220'], 'exato primeiro, prefixo depois');
  assert.deepEqual(find('01A-3'), ['1a-3', '1a-31']);
  assert.deepEqual(find('1A/11'), ['1a-11']);
  assert.deepEqual(find('BLOCO 01A, N 3'), ['1a-3', '1a-31']);
  assert.deepEqual(find('quadra 3 lote 10'), ['q3']);
});

test('só bloco, só número e zeros à esquerda', () => {
  assert.deepEqual(find('1A').sort(), ['1a-11', '1a-3', '1a-31']);
  assert.deepEqual(find('01a').sort(), ['1a-11', '1a-3', '1a-31'], "'01A' ≡ '1A'");
  assert.ok(!find('1A').includes('10b-22'), '1A não casa 10B');
  assert.ok(find('1').includes('1-101') && find('1').includes('1a-11'));
  assert.equal(unitCode('Bloco 01A'), '1a');
  assert.equal(unitCode('003'), '3');
  assert.equal(unitCode('101'), '101');
});

test('nome de pessoa não vira consulta de unidade; acentos/caixa ignorados', () => {
  assert.equal(parseUnitQuery('João Silva'), null);
  assert.equal(parseUnitQuery(''), null);
  assert.deepEqual(find('Marina'), []);
  assert.ok(textMatches('João da Silva', 'joao silva'));
  assert.ok(textMatches('MARIA CONCEIÇÃO', 'conceicao'));
  assert.ok(!textMatches('Maria', 'mario'));
});

test('blocos distintos em ordem natural', () => {
  assert.deepEqual(distinctBlocks(units).map((b) => b.key), ['1', '1a', '10b', '15b', '3']);
});
