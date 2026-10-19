/**
 * Conexão do WhatsApp (Evolution API) por condomínio.
 *   POST /api/whatsapp/connect  { tenantId } -> QR Code para parear o celular do condomínio
 *   POST /api/whatsapp/status   { tenantId } -> conectado ou não
 * O nome da instância é derivado no servidor (pp-<tenant>); o cliente nunca
 * informa URL, instância ou destinatário. Exige permissão "settings" e plano com WhatsApp.
 */
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';
import { env } from '../_lib/env.js';

function findQr(obj: any, depth = 0): string | null {
  if (!obj || depth > 4 || typeof obj !== 'object') return null;
  for (const k of ['base64', 'qrcode', 'code']) {
    const v = obj[k];
    if (typeof v === 'string' && v.startsWith('data:image/png;base64,')) return v;
    if (v && typeof v === 'object') {
      const n = findQr(v, depth + 1);
      if (n) return n;
    }
  }
  return null;
}

export const POST = handler(async (request) => {
  const action = new URL(request.url).pathname.split('/').pop();
  const { tenantId } = await readJson(request, 1024);
  if (!isUuid(tenantId)) throw new HttpError(400, 'Condomínio inválido.');
  const { client } = await requireUser(request);
  const { data: canSettings, error } = await client.rpc('has_settings_and_whatsapp', { p_tenant: tenantId });
  if (error) rpcError(error);
  if (!canSettings) throw new HttpError(403, 'Requer permissão de configurações e plano com WhatsApp.');

  const base = env('EVOLUTION_API_URL').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', apikey: env('EVOLUTION_API_KEY') };
  const instance = `pp-${tenantId.slice(0, 8)}-${tenantId.slice(-4)}`;
  const t = () => AbortSignal.timeout(15000);

  if (action === 'status') {
    const r = await fetch(`${base}/instance/connectionState/${instance}`, { headers, signal: t() });
    if (r.status === 404) return json({ connected: false, exists: false });
    const d: any = await r.json().catch(() => ({}));
    const connected = (d?.instance?.state || d?.state) === 'open';
    await serviceClient().rpc('set_whatsapp_instance', { p_tenant: tenantId, p_instance: instance, p_enabled: connected });
    return json({ connected, exists: true });
  }

  if (action === 'connect') {
    const list = await fetch(`${base}/instance/fetchInstances?instanceName=${instance}`, { headers, signal: t() });
    const exists = list.ok && JSON.stringify(await list.json().catch(() => [])).includes(instance);
    if (!exists) {
      const c = await fetch(`${base}/instance/create`, {
        method: 'POST', headers, signal: t(),
        body: JSON.stringify({ instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
      });
      const qr = findQr(await c.json().catch(() => ({})));
      await serviceClient().rpc('set_whatsapp_instance', { p_tenant: tenantId, p_instance: instance, p_enabled: false });
      if (qr) return json({ qrCodeBase64: qr });
    }
    const r = await fetch(`${base}/instance/connect/${instance}`, { headers, signal: t() });
    const d: any = await r.json().catch(() => ({}));
    if ((d?.instance?.state || d?.state) === 'open') return json({ alreadyConnected: true });
    const qr = findQr(d);
    if (!qr) throw new HttpError(502, 'A Evolution API não devolveu o QR Code. Tente novamente.');
    return json({ qrCodeBase64: qr });
  }

  throw new HttpError(404, 'Ação desconhecida.');
});
