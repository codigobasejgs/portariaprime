/**
 * POST /api/billing/reconcile  { orderId, transactionNsu?, slug? }
 * Usado pela página de retorno. Os IDs da URL de retorno só servem para
 * PERGUNTAR à InfinitePay; quem decide é a consulta /payment_check e a RPC
 * apply_verified_payment (valor, pedido e tenant conferidos no banco).
 * Rate limit: no máximo 1 consulta ao provedor a cada 10 s por pedido.
 */
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';
import { verifyAndApply } from '../_lib/payments.js';
import { ProviderError } from '../_lib/infinitepay.js';

const lastCheck = new Map<string, number>();
const idOk = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v);

export const POST = handler(async (request) => {
  const body = await readJson(request, 4096);
  if (!isUuid(body.orderId)) throw new HttpError(400, 'Pedido inválido.');
  const { client } = await requireUser(request);
  const { data: order, error } = await client.rpc('get_order', { p_order: body.orderId });
  if (error) rpcError(error);
  if (order.status === 'paid') return json({ status: 'paid', periodEnd: order.period_end });

  const svc = serviceClient();
  const { data: ids } = await svc.rpc('order_for_reconcile', { p_order: body.orderId });
  const transactionNsu = ids?.transaction_nsu || (idOk(body.transactionNsu) ? body.transactionNsu : null);
  const slug = ids?.slug || (idOk(body.slug) ? body.slug : null);
  if (!transactionNsu || !slug) {
    // Sem os identificadores, a API documentada não permite consultar: aguarda o webhook.
    return json({ status: 'pending', message: 'Aguardando confirmação da InfinitePay.' });
  }

  const now = Date.now();
  if (now - (lastCheck.get(body.orderId) || 0) < 10_000) return json({ status: 'pending', retryAfter: 10 });
  lastCheck.set(body.orderId, now);

  try {
    const r = await verifyAndApply(svc, { orderNsu: ids.order_nsu, transactionNsu, slug });
    if (r.result === 'activated' || r.result === 'duplicate_ignored') return json({ status: 'paid' });
    if (r.result === 'review') return json({ status: 'review', message: 'Pagamento recebido com divergência. Nossa equipe vai analisar.' });
    return json({ status: 'pending' });
  } catch (e) {
    if (e instanceof ProviderError) return json({ status: 'pending', message: e.message });
    throw e;
  }
});
