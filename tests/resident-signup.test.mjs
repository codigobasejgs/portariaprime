// Validação do cadastro do morador no cliente (espelho da regra do banco).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPhone, phoneE164, validate, validEmail, validFullName, blocksOf, unitsOf, unitValue, OTHER } from '../src/lib/resident-signup.ts';

test('celular: máscara enquanto digita e E.164 (mesma regra do banco)', () => {
  assert.equal(maskPhone('11988887777'), '(11) 98888-7777');
  assert.equal(maskPhone('5511988887777'), '(11) 98888-7777');
  assert.equal(maskPhone('119'), '(11) 9');
  assert.equal(phoneE164('(11) 98888-7777'), '+5511988887777');
  assert.equal(phoneE164('+55 11 98888-7777'), '+5511988887777');
  for (const bad of ['1133334444', '09988887777', '1098887777', '119888877', '']) assert.equal(phoneE164(bad), null, bad);
});

test('nome e e-mail', () => {
  assert.ok(validFullName('Ana Souza'));
  assert.ok(!validFullName('Ana'));
  assert.ok(validEmail(' Ana@Exemplo.com.br '));
  assert.ok(!validEmail('ana@exemplo'));
});

test('formulário: obrigatórios, bloco quando há blocos, unidade da lista, senhas e termo', () => {
  const units = [{ block: 'A', label: '101' }, { block: 'A', label: '102' }, { block: 'B', label: '201' }];
  const ok = { name: 'Ana Souza', email: 'ana@x.com', phone: '(11) 98888-7777', block: 'A', unit: '101', unitFree: '', password: 'SenhaForte1', password2: 'SenhaForte1', accepted: true };
  assert.deepEqual(validate(ok, true, units, true), {});
  const e = validate({ ...ok, name: 'Ana', email: 'x', phone: '1', block: '', unit: '', password: 'curta', password2: 'outra', accepted: false }, true, units, true);
  assert.deepEqual(Object.keys(e).sort(), ['accepted', 'block', 'email', 'name', 'password', 'password2', 'phone', 'unit']);
  assert.deepEqual(Object.keys(validate({ ...ok, email: '', password: '' , password2: 'x' }, true, units, true, false)), [], 'logado: sem e-mail/senha');
  assert.ok(validate({ ...ok, block: 'B', unit: '101' }, true, units, true).unit, 'unidade de outro bloco recusada');
  assert.ok(validate({ ...ok, unit: OTHER }, true, units, true).unitFree, 'fora da lista exige o texto');
  assert.deepEqual(validate({ ...ok, unit: OTHER, unitFree: '103' }, true, units, true), {}, 'unidade fora da lista vai para análise');
  assert.equal(unitValue({ ...ok, unit: OTHER, unitFree: ' 103 ' }), '103');
  assert.equal(unitValue(ok), '101');
  assert.ok(validate(ok, true, units, false).term, 'sem termo carregado não envia');
  assert.deepEqual(validate({ ...ok, block: '', unit: '1' }, false, [{ block: null, label: '1' }], true), {}, 'sem blocos: bloco não exigido');
  assert.equal(validate(ok, true, units, true).accepted, undefined);
});

test('blocos e unidades por bloco', () => {
  const units = [{ block: 'A', label: '101' }, { block: 'B', label: '201' }, { block: 'A', label: '102' }];
  assert.deepEqual(blocksOf(units), ['A', 'B']);
  assert.deepEqual(unitsOf(units, 'A', true).map((u) => u.label), ['101', '102']);
  assert.equal(unitsOf(units, '', false).length, 3);
});
