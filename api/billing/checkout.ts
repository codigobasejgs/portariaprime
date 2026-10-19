/**
 * POST /api/billing/checkout  { tenantId }
 * Gestor com permissão de faturamento gera (ou reaproveita) o link de pagamento
 * do pedido aberto. Preço, plano e período vêm do banco — nada do navegador.
 * Durante o mês grátis a RPC recusa (não há cobrança antecipada).
 */
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';
import { appUrl } from '../_lib/env.js';
import { createCheckoutLink, ProviderError } from '../_lib/infinitepay.js';

export const POST = handler(async (request) => {
  const { tenantId } = await readJson(request, 2048);
  if (!isUuid(tenantId)) throw new HttpError(400, 'Condomínio inválido.');
  const { client, user } = await requireUser(request);

  const { data: order, error } = await client.rpc('prepare_checkout', { p_tenant: tenantId });
  if (error) rpcError(error);
  if (order.status === 'pending' && order.checkout_url) {
    return json({ orderId: order.order_id, checkoutUrl: order.checkout_url, reused: true });
  }

  const base = appUrl();
  const svc = serviceClient();
  try {
    const url = await createCheckoutLink({
      orderNsu: order.order_nsu,
      amountCents: order.amount_cents,
      description: order.description,
      redirectUrl: `${base}/checkout/retorno?pedido=${order.order_id}`,
      webhookUrl: `${base}/api/webhooks/infinitepay`,
      customer: user.email ? { email: user.email } : undefined,
    });
    await svc.rpc('order_set_link', { p_order: order.order_id, p_url: url, p_ok: true });
    return json({ orderId: order.order_id, checkoutUrl: url, reused: false });
  } catch (e) {
    if (e instanceof ProviderError) {
      if (!e.ambiguous) await svc.rpc('order_set_link', { p_order: order.order_id, p_url: null, p_ok: false });
      return json({ orderId: order.order_id, error: e.message }, 502);
    }
    throw e;
  }
});
