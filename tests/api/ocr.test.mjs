import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabel, readLabel } from '../../api/ocr/analyze-label.ts';

test('OCR: modelo principal, reserva para erro/JSON inválido e falha explícita', async () => {
  const calls = [];
  const ai = { models: { generateContent: async input => {
    calls.push(input);
    return { text: JSON.stringify({ carrier: 'Correios', confidence: 90, unit: '101A' }) };
  } } };
  const result = await readLabel(ai, 'image/png', 'AAAA');
  assert.equal(result.unit, '101A');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.httpOptions.timeout, 12000);
  assert.equal(calls[0].config.maxOutputTokens, 8192);
  for (const mode of ['error', 'json']) {
    calls.length = 0;
    ai.models.generateContent = async input => {
      calls.push(input);
      if (calls.length === 1) {
        if (mode === 'error') throw new Error('provedor indisponível');
        return { text: 'JSON truncado' };
      }
      return { text: '{"carrier":"Outra","confidence":0}' };
    };
    assert.equal((await readLabel(ai, 'image/png', 'AAAA')).confidence, 0);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].model, calls[1].model);
  }
  ai.models.generateContent = async () => ({ text: 'null' });
  await assert.rejects(readLabel(ai, 'image/png', 'AAAA'), /indisponível/);
});

test('OCR: códigos de triagem não viram unidade/bloco; campos separados e saneados', () => {
  const r = normalizeLabel({
    carrier: 'Mercado Livre', recipientName: ' Jefferson Gomes dos Santos ', senderName: 'Loja Exemplo',
    unit: 'LSP-105', block: 'RJ2-2', complement: 'Apto 12B', trackingCode: 'MLB123', orderNumber: '2000001',
    invoiceNumber: null, evidence: [{ field: 'recipientName', text: 'Jefferson Gomes dos Santos' }, { bad: 1 }],
    alerts: ['x'.repeat(500)], confidence: 140,
  });
  assert.equal(r.unit, null);
  assert.equal(r.block, null);
  assert.equal(r.recipientName, 'Jefferson Gomes dos Santos');
  assert.equal(r.senderName, 'Loja Exemplo');
  assert.equal(r.complement, 'Apto 12B');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.confidence, 100);
  assert.ok(r.alerts.some((a) => a.includes('LSP-105')) && r.alerts.some((a) => a.includes('RJ2-2')));
  assert.ok(r.alerts[0].length <= 160);
  assert.equal(normalizeLabel({ unit: 'J', confidence: 50 }).unit, null);
  assert.equal(normalizeLabel({ unit: '12B', block: 'A', confidence: 50 }).unit, '12B');
  assert.equal(normalizeLabel({ unit: '15', confidence: 50 }).unit, '15');
});

test('OCR: endereço horizontal (quadra/lote, rua/casa) e prefixos de prédio', () => {
  const pick = (d) => { const r = normalizeLabel({ confidence: 80, ...d }); return [r.block, r.unit]; };
  assert.deepEqual(pick({ block: 'Quadra B', unit: 'Lote 15' }), ['B', '15']);
  assert.deepEqual(pick({ unit: 'Qd 3 Lt 15' }), ['3', '15'], 'tudo junto na unidade');
  assert.deepEqual(pick({ block: 'QD3 LT15' }), ['3', '15'], 'sem espaço');
  assert.deepEqual(pick({ complement: 'Qd. 7, Lt. 2A' }), ['7', '2A'], 'só no complemento');
  assert.deepEqual(pick({ block: 'Rua das Palmeiras', unit: 'Casa 12' }), ['Rua das Palmeiras', '12'], 'nome de rua interna fica');
  assert.deepEqual(pick({ complement: 'Rua das Palmeiras, Casa 12' }), ['Rua das Palmeiras', '12']);
  assert.deepEqual(pick({ block: 'Bloco A', unit: 'Apto 12B' }), ['A', '12B']);
  assert.deepEqual(pick({ block: 'Torre 2', unit: 'Ap. 101' }), ['2', '101']);
  assert.deepEqual(pick({ block: 'A', unit: '101' }), ['A', '101'], 'sem prefixo, igual');
  assert.deepEqual(pick({ block: 'RJ2-2', unit: 'Casa 4' }), [null, '4'], 'rota continua descartada');
  assert.deepEqual(pick({ complement: 'Fundos' }), [null, null], 'complemento sem endereço não inventa');
});
