import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validDescriptor, faceDistance, documentValue, FACE_THRESHOLD } from '../api/_lib/porter-face.js';

test('validDescriptor accepts 128 finite floats in [-2,2]', () => {
  const ok = Array(128).fill(0.1);
  assert.equal(validDescriptor(ok), true);
  assert.equal(validDescriptor(Array(127).fill(0.1)), false);
  assert.equal(validDescriptor(Array(129).fill(0.1)), false);
  assert.equal(validDescriptor(Array(128).fill(3.0)), false);
  assert.equal(validDescriptor(Array(128).fill(0)), false); // sum of squares = 0 < 0.01
  const nanArr = Array(128).fill(0.1); nanArr[5] = NaN;
  assert.equal(validDescriptor(nanArr), false);
  assert.equal(validDescriptor(null), false);
  assert.equal(validDescriptor('not array'), false);
});

test('faceDistance computes Euclidean distance correctly', () => {
  const a = Array(128).fill(0.1);
  const b = Array(128).fill(0.1);
  assert.equal(faceDistance(a, b), 0);

  const c = Array(128).fill(0.1);
  c[0] = 0.4; // diff = 0.3
  assert.equal(Math.round(faceDistance(a, c) * 1000) / 1000, 0.3);

  // Threshold is 0.45 (pilot conservative value, not calibrated FAR)
  assert.equal(FACE_THRESHOLD, 0.45);
  assert.equal(faceDistance(a, c) <= FACE_THRESHOLD, true);
});

test('documentValue validates and formats CPF with check digits', () => {
  // Valid CPFs
  assert.equal(documentValue('CPF', '529.982.247-25'), '52998224725');
  assert.equal(documentValue('CPF', '11144477735'), '11144477735');

  // Invalid check digits
  assert.throws(() => documentValue('CPF', '11144477736'), /CPF inválido/);
  // Repeated digits
  assert.throws(() => documentValue('CPF', '11111111111'), /CPF inválido/);
  // Length
  assert.throws(() => documentValue('CPF', '123'), /Documento inválido/);
});

test('documentValue validates CNH and RG', () => {
  assert.equal(documentValue('CNH', '12345678901'), '12345678901');
  assert.throws(() => documentValue('CNH', '12345'), /Documento inválido/);

  assert.equal(documentValue('RG', 'MG-12.345.678'), 'MG12345678');
  assert.throws(() => documentValue('RG', '12'), /Documento inválido/);
  assert.throws(() => documentValue('OUTRO', '12345'), /Documento inválido/);
});
