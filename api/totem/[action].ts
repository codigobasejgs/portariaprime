/**
 * Totem pareado (substitui o antigo /api/totem/session, que entregava tokens Auth
 * da conta de serviço a qualquer chamador).
 *
 *   POST /api/totem/pair         { code }                -> { deviceSecret, tenantSlug }
 *   POST /api/totem/context      header X-Device-Secret  -> unidades (bloco/unidade apenas)
 *   POST /api/totem/receive      header X-Device-Secret  -> recebimento direto + local + avisos
 *   POST /api/totem/preregister  header X-Device-Secret  -> legado, somente clientes antigos
 *   POST /api/totem/kiosk-*      agente Android gerenciado (ver _kiosk.ts)
 *
 * O dispositivo guarda só a própria credencial (hash no banco, revogável pelo síndico).
 * Nenhum token de usuário, lista de moradores, telefone ou histórico é exposto.
 */
import { handler, json, readJson, HttpError, sha256Hex, randomToken, isUuid } from '../_lib/http.js';
import { serviceClient, rpcError } from '../_lib/supabase.js';
import { GoogleGenAI } from '@google/genai';
import { env } from '../_lib/env.js';
import { normalizeLabel, readLabel } from '../ocr/analyze-label.js';
import { kiosk } from './_kiosk.js';

const attempts = new Map<string, { n: number; at: number }>();
function limit(key: string, max: number) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.at > 60_000) return attempts.set(key, { n: 1, at: now });
  if (++a.n > max) throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto.');
}

async function secretHash(request: Request) {
  const s = request.headers.get('x-device-secret') || '';
  if (!/^[0-9a-f]{64}$/.test(s)) throw new HttpError(401, 'Totem não pareado.');
  return sha256Hex(s);
}

export const POST = handler(async (request) => {
  const action = new URL(request.url).pathname.split('/').pop();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  if (action?.startsWith('kiosk-')) return kiosk(action, request, ip);
  const svc = serviceClient();

  if (action === 'pair') {
    limit(`pair:${ip}`, 10);
    const { code } = await readJson(request, 1024);
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{8}$/.test(code)) throw new HttpError(400, 'Código inválido.');
    const secret = randomToken(32);
    const { data, error } = await svc.rpc('device_pair', { p_code: code, p_secret_hash: await sha256Hex(secret) });
    if (error) rpcError(error);
    return json({ deviceSecret: secret, tenantSlug: data.tenant_slug, deviceId: data.device_id });
  }

  if (action === 'context') {
    const { data, error } = await svc.rpc('device_context', { p_secret_hash: await secretHash(request) });
    if (error) rpcError(error);
    return json({ deviceName: data.device_name, units: data.units,
      labels: { group: data.group_label || 'Bloco', number: data.number_label || 'Apartamento' } });
  }

  if (action === 'ocr') {
    const hash = await secretHash(request);
    const body = await readJson(request, 6 * 1024 * 1024);
    const image = typeof body.imageBase64 === 'string' && body.imageBase64.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!image) throw new HttpError(400, 'Envie uma foto JPEG, PNG ou WebP.');
    if (image[2].length * 3 / 4 > 4 * 1024 * 1024) throw new HttpError(413, 'Foto grande demais (máx. 4 MB).');
    const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
    const { data: allowed, error } = await svc.rpc('device_consume_ocr', { p_secret_hash: hash });
    if (error) rpcError(error);
    if (!allowed) return json({ error: 'OCR indisponível no plano ou franquia esgotada. Preencha manualmente.', manual: true }, 402);
    let label;
    try { label = normalizeLabel(await readLabel(ai, image[1], image[2])); }
    catch { return json({ error: 'Não foi possível ler a etiqueta. Tente outra foto ou preencha manualmente.', manual: true }, 502); }
    // Revogação durante a chamada externa também impede devolver a leitura.
    const checked = await svc.rpc('device_context', { p_secret_hash: hash });
    if (checked.error) rpcError(checked.error);
    // Só dados extraídos da foto, nunca busca de moradores ou contatos do cadastro.
    return json({ carrier: label.carrier, trackingCode: label.trackingCode, block: label.block,
      unit: label.unit, confidence: label.confidence });
  }

  if (action === 'preregister' || action === 'receive') {
    const hash = await secretHash(request);
    limit(`pre:${hash}`, 30);
    const b = await readJson(request, 4096);
    if (typeof b.idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(b.idempotencyKey)) throw new HttpError(400, 'Requisição inválida.');
    if ((action === 'receive' || b.unitId != null) && !isUuid(b.unitId)) throw new HttpError(400, 'Selecione uma unidade válida.');
    const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);
    const { data, error } = await svc.rpc(action === 'receive' ? 'device_receive' : 'device_preregister', {
      p_secret_hash: hash, p_idempotency_key: b.idempotencyKey, p_unit: b.unitId ?? null,
      p_carrier: s(b.carrier, 40), p_tracking: s(b.trackingCode, 80), p_courier: s(b.courierName, 80),
    });
    if (error) rpcError(error);
    return json({ ok: true, replayed: data.replayed, ...(action === 'receive' ? {
      storage_code: data.storage_code, storage_rack: data.storage_rack,
      storage_shelf: data.storage_shelf, concierge_name: data.concierge_name,
    } : {}) });
  }

  throw new HttpError(404, 'Ação desconhecida.');
});
