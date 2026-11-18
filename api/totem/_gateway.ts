/**
 * Gateway local do condomínio (agente de borda). Conexão sempre de SAÍDA, do gateway para a nuvem; nada é aberto
 * na rede do condomínio. P0: só o simulador (gateway/simulator.mjs) — a nuvem não emite comando físico.
 *
 *   POST /api/totem/gateway-pair       { code, agentVersion }               -> { gatewaySecret, gatewayId }
 *   POST /api/totem/gateway-heartbeat  header X-Gateway-Secret { clock, devices[] } -> { commands[] }
 *   POST /api/totem/gateway-result     header X-Gateway-Secret { commandId, seq, nonce, result, detail } -> { status }
 *
 * O segredo do gateway só existe no gateway; o banco guarda o hash. Revogar no painel invalida na próxima chamada.
 */
import { HttpError, json, randomToken, readJson, sha256Hex } from '../_lib/http.js';
import { rpcError, serviceClient } from '../_lib/supabase.js';

const RESULTS = ['acknowledged', 'physically_confirmed', 'failed', 'unknown'];

async function secretHash(request: Request) {
  const s = request.headers.get('x-gateway-secret') || '';
  if (!/^[0-9a-f]{64}$/.test(s)) throw new HttpError(401, 'Gateway não pareado.');
  return sha256Hex(s);
}

export async function gateway(action: string, request: Request, limit: (key: string, max: number) => void, ip: string): Promise<Response> {
  const svc = serviceClient();
  if (action === 'gateway-pair') {
    limit(`gwpair:${ip}`, 10);
    const { code, agentVersion } = await readJson(request, 1024);
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{10}$/.test(code)) throw new HttpError(400, 'Código inválido.');
    const secret = randomToken(32);
    const { data, error } = await svc.rpc('gateway_pair', { p_code: code, p_secret_hash: await sha256Hex(secret), p_agent_version: String(agentVersion || '').slice(0, 40) });
    if (error) rpcError(error);
    return json({ gatewaySecret: secret, gatewayId: data.gateway_id });
  }
  if (action === 'gateway-heartbeat') {
    const hash = await secretHash(request);
    limit(`gwhb:${hash}`, 30);
    const b = await readJson(request, 32 * 1024);
    // Só ISO 8601 completo vai ao banco (Date.parse aceita "1", o timestamptz não): o resto vira o relógio do servidor.
    const clock = typeof b.clock === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(b.clock) && !Number.isNaN(Date.parse(b.clock))
      ? b.clock : new Date().toISOString();
    const { data, error } = await svc.rpc('gateway_heartbeat', { p_secret_hash: hash, p_clock: clock, p_devices: Array.isArray(b.devices) ? b.devices.slice(0, 50) : [] });
    if (error) rpcError(error);
    return json({ gatewayId: data.gateway_id, commands: data.commands });
  }
  if (action === 'gateway-result') {
    const hash = await secretHash(request);
    limit(`gwres:${hash}`, 60);
    const b = await readJson(request, 2048);
    if (!/^[0-9a-f-]{36}$/.test(String(b.commandId)) || !Number.isInteger(b.seq) || !/^[0-9a-f]{32}$/.test(String(b.nonce)) || !RESULTS.includes(b.result)) {
      throw new HttpError(400, 'Resultado inválido.');
    }
    const { data, error } = await svc.rpc('gateway_command_result', { p_secret_hash: hash, p_command: b.commandId, p_seq: b.seq, p_nonce: b.nonce,
      p_result: b.result, p_detail: typeof b.detail === 'string' ? b.detail.slice(0, 200) : null });
    if (error) rpcError(error);
    return json({ status: data });
  }
  throw new HttpError(404, 'Ação desconhecida.');
}
