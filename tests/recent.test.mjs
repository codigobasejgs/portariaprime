// Sugestões de preenchimento: lembrados primeiro, depois os mais frequentes, depois os fixos; sem repetir grafias.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, recall, remember, suggestions } from '../src/lib/recent.ts';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };

test('ordem: lembrados, frequentes no histórico, fixos; sem duplicar maiúsculas/acentos', () => {
  const out = suggestions(['Loggi'], ['Shopee', 'shopee', 'Amazon', 'SHOPEE', null, ''], ['Correios', 'Amazon', 'Shopee']);
  assert.deepEqual(out, ['Loggi', 'Shopee', 'Amazon', 'Correios']);
  assert.equal(suggestions([], ['a', 'b'], ['C', 'D', 'E'], 2).length, 2);
});

test('lembra por condomínio, o último uso vem primeiro, ignora vazio', () => {
  remember('t1', 'carrier', 'Jadlog');
  remember('t1', 'carrier', 'Loggi');
  remember('t1', 'carrier', 'jadlog');
  remember('t1', 'carrier', ' ');
  assert.deepEqual(recall('t1', 'carrier'), ['jadlog', 'Loggi']);
  assert.deepEqual(recall('t2', 'carrier'), []);
});

test('valor gravado inválido no aparelho não quebra a tela', () => {
  mem.set('pp_recent:t3:volume', '{"x":1}');
  assert.deepEqual(recall('t3', 'volume'), []);
  mem.set('pp_recent:t3:volume', 'não é json');
  assert.deepEqual(recall('t3', 'volume'), []);
});

test('grafia conhecida prevalece', () => {
  assert.equal(canonical(' correios ', ['Correios', 'Shopee']), 'Correios');
  assert.equal(canonical('Jadlog', ['Correios']), 'Jadlog');
});
