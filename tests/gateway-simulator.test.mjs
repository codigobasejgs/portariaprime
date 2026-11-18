// Simulador do gateway contra uma nuvem falsa que segue o contrato de /api/totem/gateway-*: fila persistente
// quando offline, assinatura devolvida como recebida, sem sensor nunca alega confirmação física, revogado para.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycle, inventory, loadState, pair, simulate } from '../gateway/simulator.mjs';

function cloud() {
  const st = { secret: null, commands: [], results: [], down: false, revoked: false };
  const fetchImpl = async (url, init) => {
    if (st.down) throw new TypeError('fetch failed');
    const path = new URL(url).pathname.split('/').pop(); const b = JSON.parse(init.body);
    const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
    if (path === 'gateway-pair') { st.secret = 'a'.repeat(64); return ok({ gatewaySecret: st.secret, gatewayId: 'g-1' }); }
    if (st.revoked || init.headers['x-gateway-secret'] !== st.secret) return new Response('{"error":"Gateway não autorizado."}', { status: 401 });
    if (path === 'gateway-heartbeat') { st.devices = b.devices; const c = st.commands; st.commands = []; return ok({ commands: c }); }
    if (path === 'gateway-result') { st.results.push(b); return ok({ status: b.result }); }
    return new Response('{}', { status: 404 });
  };
  return { st, fetchImpl };
}

test('ciclo completo, fila offline e confirmação física só com sensor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-')); const statePath = join(dir, 's.json');
  try {
    const { st, fetchImpl } = cloud(); const api = 'https://cloud.test';
    assert.equal(await pair({ api, code: 'ABCDEFGH12', statePath, fetchImpl }), 'g-1');
    const [gate] = inventory('g-1');
    assert.deepEqual(inventory('g-1'), inventory('g-1'), 'inventário determinístico');
    assert.ok(inventory('g-1').every((d) => d.driver === 'simulator'));
    const cmd = (seq) => ({ id: `c0000000-0000-4000-8000-00000000000${seq}`, device_id: gate.id, action: 'pulse_open', seq, nonce: 'b'.repeat(32), expires_at: new Date(Date.now() + 30000).toISOString() });

    st.commands = [cmd(1)];
    const r1 = await cycle({ api, statePath, fetchImpl });
    assert.deepEqual([r1.commands, r1.sent, r1.queued], [1, 1, 0]);
    assert.deepEqual([st.results[0].seq, st.results[0].nonce, st.results[0].result], [1, 'b'.repeat(32), 'acknowledged'], 'sem sensor: só recebido');

    // Nuvem caiu depois de entregar o comando: resultado fica na fila em disco e sai no próximo ciclo.
    st.commands = [cmd(2)];
    const realFetch = fetchImpl; let n = 0;
    const flaky = async (u, i) => { if (new URL(u).pathname.endsWith('gateway-result') && n++ === 0) throw new TypeError('fetch failed'); return realFetch(u, i); };
    const r2 = await cycle({ api, statePath, fetchImpl: flaky });
    assert.deepEqual([r2.offline, r2.queued], [true, 1]);
    assert.equal(loadState(statePath).outbox[0].seq, 2, 'fila persistida');
    const r3 = await cycle({ api, statePath, fetchImpl });
    assert.deepEqual([r3.sent, r3.queued], [1, 0]);
    assert.equal(st.results.filter((x) => x.seq === 2).length, 1, 'enviado uma vez');

    // Com sensor simulado: confirmação física.
    st.commands = [cmd(3)];
    await cycle({ api, statePath, sensor: true, fetchImpl });
    assert.equal(st.results.at(-1).result, 'physically_confirmed');

    // Revogado: o simulador para (erro), não fica tentando em silêncio.
    st.revoked = true;
    await assert.rejects(cycle({ api, statePath, fetchImpl }), /não autorizado/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('simulate: ação não suportada, dispositivo desconhecido e expirado falham', () => {
  const devs = inventory('g-2');
  const base = { device_id: devs[1].id, action: 'pulse_open', expires_at: new Date(Date.now() + 1000).toISOString() };
  assert.equal(simulate(base, devs).result, 'failed', 'câmera não abre portão');
  assert.equal(simulate({ ...base, device_id: 'x' }, devs).result, 'failed');
  assert.equal(simulate({ ...base, device_id: devs[0].id, expires_at: new Date(Date.now() - 1).toISOString() }, devs).result, 'failed');
});
