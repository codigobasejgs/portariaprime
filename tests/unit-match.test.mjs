import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchUnits } from '../src/lib/unit-match.ts';

const units = [
  { id: 'v1', block: 'A', label: '101', active: true },
  { id: 'v2', block: 'A', label: '102', active: false },
  { id: 'h1', block: 'Rua das Palmeiras', label: '12', active: true },
  { id: 'h2', block: 'Quadra 3', label: 'Lote 10', active: true },
  { id: 'h3', block: 'Alameda das Rosas', label: 'Casa 7', active: true },
  { id: 'h4', block: 'B', label: '15', active: true },
];
const ids = (q) => matchUnits(units, q).map((u) => u.id);

test('busca vertical continua como antes', () => {
  assert.deepEqual(ids('a 101'), ['v1']);
  assert.deepEqual(ids('bloco a apto 101'), ['v1']);
  assert.deepEqual(ids('102'), [], 'unidade inativa não aparece');
});

test('busca horizontal: quadra/lote, rua/casa e abreviações', () => {
  assert.deepEqual(ids('quadra 3 lote 10'), ['h2']);
  assert.deepEqual(ids('qd 3 lt 10'), ['h2']);
  assert.deepEqual(ids('rua das palmeiras casa 12'), ['h1']);
  assert.deepEqual(ids('palmeiras 12'), ['h1']);
  assert.deepEqual(ids('alameda das rosas casa 7'), ['h3'], 'nome que começa com "Al" não é cortado');
  assert.deepEqual(ids('b 15'), ['h4']);
});

test('vazio lista ativas; limite de 30', () => {
  assert.equal(ids('').length, 5);
  const many = Array.from({ length: 50 }, (_, i) => ({ id: String(i), block: null, label: String(i), active: true }));
  assert.equal(matchUnits(many, '').length, 30);
});
