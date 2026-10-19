/**
 * GET /api/billing/order?id=<uuid>
 * Pedido mínimo e sanitizado, somente para gestor de faturamento do condomínio
 * (a RPC get_order valida o vínculo).
 */
import { handler, json, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, rpcError } from '../_lib/supabase.js';

export const GET = handler(async (request) => {
  const id = new URL(request.url).searchParams.get('id');
  if (!isUuid(id)) throw new HttpError(400, 'Pedido inválido.');
  const { client } = await requireUser(request);
  const { data, error } = await client.rpc('get_order', { p_order: id });
  if (error) rpcError(error);
  return json(data);
});
