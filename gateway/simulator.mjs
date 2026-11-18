#!/usr/bin/env node
/**
 * Simulador determinístico do gateway local do Portaria Prime (P0). NUNCA envia comando físico: não abre portas
 * seriais, não acessa rede local, não fala ONVIF/RTSP/SIP. Serve para exercitar o contrato nuvem ↔ gateway:
 * pareamento por código, heartbeat com relógio, inventário, fila persistente de resultados (offline), assinatura
 * dos comandos (seq + nonce devolvidos como recebidos) e a diferença entre "recebido" e "confirmado fisicamente".
 *
 * Uso:
 *   node gateway/simulator.mjs pair  --api https://portariaprime.com.br --code ABCDEFGH12 --state ./gw-state.json
 *   node gateway/simulator.mjs run   --api ... --state ./gw-state.json [--once] [--sensor] [--offline]
 *
 * O arquivo de estado guarda o segredo do gateway (permissão 600 em Linux/macOS) e a fila de resultados pendentes.
 * ponytail: agente de produção (Go, mTLS, SQLCipher, drivers) é P1/P2; este simulador fixa o contrato antes disso.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const AGENT_VERSION = 'sim-0.1.0';

/** Dispositivos fictícios com ids estáveis derivados do gateway (mesmo inventário a cada execução). */
export function inventory(gatewayId, { sensor = false } = {}) {
  const id = (n) => {
    const h = createHash('sha256').update(`${gatewayId}:${n}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  return [
    { id: id('gate'), name: 'Portão social (simulado)', device_type: 'access_point', driver: 'simulator',
      capabilities: ['pulse_open', 'read_state'], has_physical_sensor: sensor, state: 'online' },
    { id: id('cam'), name: 'Câmera da entrada (simulada)', device_type: 'camera', driver: 'simulator',
      capabilities: ['snapshot'], has_physical_sensor: false, state: 'online' },
  ];
}

export function loadState(path) {
  if (!existsSync(path)) return { gatewayId: null, secret: null, outbox: [] };
  return { outbox: [], ...JSON.parse(readFileSync(path, 'utf8')) };
}
export function saveState(path, state) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);                                   // gravação atômica: fila não corrompe se o processo cair
  try { chmodSync(path, 0o600); } catch { /* Windows */ }
}

/**
 * Resposta do simulador a um comando. Sem sensor físico o gateway só pode dizer que o dispositivo RECEBEU
 * (acknowledged); "physically_confirmed" exige sensor — e a nuvem rebaixa para unknown se não houver.
 */
export function simulate(cmd, devices) {
  const d = devices.find((x) => x.id === cmd.device_id);
  if (!d) return { result: 'failed', detail: 'dispositivo desconhecido no gateway' };
  if (!d.capabilities.includes(cmd.action)) return { result: 'failed', detail: 'ação não suportada' };
  if (Date.parse(cmd.expires_at) <= Date.now()) return { result: 'failed', detail: 'expirado no gateway' };
  if (cmd.action === 'read_state') return { result: 'acknowledged', detail: d.has_physical_sensor ? 'fechado (sensor simulado)' : 'estado desconhecido (sem sensor)' };
  return d.has_physical_sensor ? { result: 'physically_confirmed', detail: 'sensor simulado: abriu e fechou' } : { result: 'acknowledged', detail: 'pulso simulado; sem sensor' };
}

async function call(api, path, body, secret, fetchImpl) {
  const r = await fetchImpl(`${api.replace(/\/$/, '')}/api/totem/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-gateway-secret': secret } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return d;
}

export async function pair({ api, code, statePath, fetchImpl = fetch }) {
  const d = await call(api, 'gateway-pair', { code, agentVersion: AGENT_VERSION }, null, fetchImpl);
  saveState(statePath, { gatewayId: d.gatewayId, secret: d.gatewaySecret, outbox: [] });
  return d.gatewayId;
}

/**
 * Um ciclo: envia resultados pendentes da fila, manda heartbeat, simula os comandos recebidos e enfileira o
 * resultado (persistido ANTES de enviar). Sem rede, tudo fica na fila e sai no próximo ciclo.
 */
export async function cycle({ api, statePath, sensor = false, offline = false, fetchImpl = fetch, log = () => {} }) {
  const st = loadState(statePath);
  if (!st.secret) throw new Error('Gateway não pareado. Rode "pair" primeiro.');
  const devices = inventory(st.gatewayId, { sensor });
  const out = { sent: 0, queued: 0, commands: 0, offline: false };
  if (offline) { out.offline = true; out.queued = st.outbox.length; return out; }
  try {
    for (const item of [...st.outbox]) {
      const r = await call(api, 'gateway-result', item, st.secret, fetchImpl);
      log(`resultado ${item.commandId.slice(0, 8)}: ${r.status}`);
      st.outbox = st.outbox.filter((x) => x !== item); saveState(statePath, st); out.sent++;
    }
    const hb = await call(api, 'gateway-heartbeat', { clock: new Date().toISOString(), devices }, st.secret, fetchImpl);
    for (const c of hb.commands || []) {
      const s = simulate(c, devices);
      st.outbox.push({ commandId: c.id, seq: c.seq, nonce: c.nonce, result: s.result, detail: s.detail });
      saveState(statePath, st); out.commands++;
    }
    for (const item of [...st.outbox]) {
      const r = await call(api, 'gateway-result', item, st.secret, fetchImpl);
      log(`resultado ${item.commandId.slice(0, 8)}: ${r.status}`);
      st.outbox = st.outbox.filter((x) => x !== item); saveState(statePath, st); out.sent++;
    }
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw e;      // revogado: para de vez
    out.offline = true;
    log(`sem conexão: ${e.message}; ${st.outbox.length} resultado(s) na fila`);
  }
  out.queued = loadState(statePath).outbox.length;
  return out;
}

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('simulator.mjs')) {
  const cmd = process.argv[2];
  const api = arg('api', 'http://127.0.0.1:3027'), statePath = arg('state', './gw-state.json');
  if (cmd === 'pair') console.log('pareado:', await pair({ api, code: arg('code'), statePath }));
  else if (cmd === 'run') {
    do {
      const r = await cycle({ api, statePath, sensor: flag('sensor'), offline: flag('offline'), log: (m) => console.log(new Date().toISOString(), m) });
      console.log(JSON.stringify(r));
      if (flag('once')) break;
      await new Promise((ok) => setTimeout(ok, 30000));
    } while (true);
  } else console.log('uso: simulator.mjs pair --api URL --code CODIGO --state ARQ | run --api URL --state ARQ [--once] [--sensor] [--offline]');
}
