/**
 * POST /api/webhooks/infinitepay
 * A InfinitePay não documenta assinatura/HMAC do webhook. Portanto:
 *   1. valida tamanho e formato;
 *   2. grava o evento (dedupe) ANTES de processar;
 *   3. só ativa após consulta independente em /payment_check.
 * Webhook forjado não ativa nada: sem pagamento real, a consulta diz paid=false.
 * Responde 200 rápido; se a gravação falhar, 400 para a InfinitePay reenviar.
 */
import { handler, json, readJson } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';
import { parseWebhook } from '../_lib/infinitepay.js';
import { verifyAndApply } from '../_lib/payments.js';

export const POST = handler(async (request) => {
  const raw = await readJson(request, 16 * 1024).catch(() => null);
  const evt = parseWebhook(raw);
  if (!evt) return json({ ok: false }, 400);

  const svc = serviceClient();
  const { data: inserted, error } = await svc
    .from('payment_events')
    .upsert(
      {
        source: 'webhook',
        dedupe_key: `webhook:${evt.transaction_nsu}`,
        order_nsu: evt.order_nsu,
        transaction_nsu: evt.transaction_nsu,
        payload: evt,
      },
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    )
    .select('id');
  if (error) {
    console.error('[webhook] falha ao gravar evento', error.message);
    return json({ ok: false }, 400);
  }
  const eventId = inserted?.[0]?.id;
  if (!eventId) return json({ ok: true, duplicate: true });

  // Processamento imediato com teto de tempo; se não der, o job /api/jobs/tick reprocessa.
  try {
    const r = await Promise.race([
      verifyAndApply(svc, { orderNsu: evt.order_nsu, transactionNsu: evt.transaction_nsu, slug: evt.invoice_slug, receiptUrl: evt.receipt_url }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    const status = r.result === 'activated' || r.result === 'duplicate_ignored' ? 'processed' : r.result === 'review' ? 'review' : 'error';
    await svc.rpc('finish_payment_event', { p_event: eventId, p_status: status, p_error: status === 'error' ? r.result : null });
  } catch (e: any) {
    await svc.rpc('finish_payment_event', { p_event: eventId, p_status: 'error', p_error: String(e?.message || e) });
  }
  return json({ ok: true });
});
