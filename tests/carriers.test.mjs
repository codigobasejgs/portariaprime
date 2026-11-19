// Transportadoras: qualquer grafia gravada acha a marca; desconhecida vira sigla neutra; lista sem nomes repetidos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARRIER_LIST, carrierInfo } from '../src/lib/carriers.ts';
import { CARRIERS } from '../src/lib/format.ts';

test('carrierInfo', () => {
  assert.equal(carrierInfo('correios').name, 'Correios');
  assert.equal(carrierInfo('SEDEX').name, 'Correios');
  assert.equal(carrierInfo('Mercado Envios').name, 'Mercado Livre');
  assert.equal(carrierInfo('Shopee Xpress').name, 'Shopee');
  assert.equal(carrierInfo('Magazine Luiza').name, 'Magalu');
  assert.equal(carrierInfo('J&T').name, 'J&T Express');
  assert.equal(carrierInfo('Amazon Logística').name, 'Amazon', 'prefixo da marca');
  const x = carrierInfo('Jadlog Teste');
  assert.equal(x.name, 'Jadlog');
  const u = carrierInfo('Transportes Silva');
  assert.deepEqual([u.name, u.mono], ['Transportes Silva', 'TS']);
  assert.equal(carrierInfo(null).name, 'Outra');
});

test('lista', () => {
  assert.equal(new Set(CARRIER_LIST.map((c) => c.name)).size, CARRIER_LIST.length);
  assert.ok(CARRIER_LIST.every((c) => c.icon || c.mono));
  assert.equal(CARRIERS.at(-1), 'Outra');
  assert.ok(CARRIERS.every((c) => c.length <= 40), 'cabe na coluna carrier (40)');
});
