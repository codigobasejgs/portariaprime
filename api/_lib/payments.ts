import type { SupabaseClient } from '@supabase/supabase-js';
import { paymentCheck } from './infinitepay.js';

/**
 * Verifica no provedor e, se pago, aplica de forma atômica/idempotente no banco.
 * Nunca ativa nada só com dados recebidos do navegador ou do webhook.
 */
export async function verifyAndApply(
  svc: SupabaseClient,
  ids: { orderNsu: string; transactionNsu: string; slug: string; receiptUrl?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<{ result: string; reason?: string }> {
  const check = await paymentCheck(ids, fetchImpl);
  if (!check.success) return { result: 'not_found' };
  if (!check.paid) return { result: 'pending' };
  const { data, error } = await svc.rpc('apply_verified_payment', {
    p_order_nsu: ids.orderNsu,
    p_transaction_nsu: ids.transactionNsu,
    p_slug: ids.slug,
    p_amount: check.amount,
    p_paid_amount: check.paid_amount,
    p_installments: check.installments,
    p_capture_method: check.capture_method,
    p_receipt_url: ids.receiptUrl || null,
  });
  if (error) throw new Error(error.message);
  return data as { result: string; reason?: string };
}
