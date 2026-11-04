import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockNames } from '../src/lib/units-generate.ts';

test('nomes dos blocos do gerador', () => {
  assert.deepEqual(blockNames('letra', 3, ''), ['A', 'B', 'C']);
  assert.deepEqual(blockNames('letra', 28, '').slice(25), ['Z', 'AA', 'AB']);
  assert.deepEqual(blockNames('numero', 2, ''), ['1', '2']);
  assert.deepEqual(blockNames('nome', 0, ' Ipê, Jacarandá\nManacá ;; '), ['Ipê', 'Jacarandá', 'Manacá']);
  assert.deepEqual(blockNames('sem', 5, ''), ['']);
  assert.equal(blockNames('numero', 500, '').length, 60, 'limite de 60 blocos');
});
