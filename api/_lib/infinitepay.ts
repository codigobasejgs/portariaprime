/**
 * Cliente do Checkout InfinitePay (CloudWalk — infinitepay.io).
 * Contrato verificado em 19/10/2026: docs/INFINITEPAY.md.
 * A documentação pública não descreve API key nem assinatura do webhook:
 * por isso o webhook é tratado como AVISO e todo pagamento é confirmado por
 * consulta independente em /payment_check antes de liberar acesso.
 */
import { env } from './env.js';

const BASE = 'https://api.checkout.infinitepay.io';

export interface CreateLinkInput {
  orderNsu: string;
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  customer?: { name?: string; email?: string };
}

export class ProviderError extends Error {
  constructor(message: string, public ambiguous = false) {
    super(message);
  }
}

function findUrl(obj: any): string | null {
  // A doc diz "recebe um link de pagamento" sem nomear o campo; aceitamos os nomes usuais.
  for (const k of ['url', 'link', 'checkout_url', 'payment_url']) {
    if (typeof obj?.[k] === 'string' && /^https:\/\//.test(obj[k])) return obj[k];
  }
  return null;
}

export async function createCheckoutLink(input: CreateLinkInput, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = {
    handle: env('INFINITEPAY_HANDLE').replace(/^\$/, ''),
    items: [{ quantity: 1, price: input.amountCents, description: input.description.slice(0, 120) }],
    order_nsu: input.orderNsu,
    redirect_url: input.redirectUrl,
    webhook_url: input.webhookUrl,
    ...(input.customer ? { customer: input.customer } : {}),
  };
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Timeout: o link pode ou não ter sido criado. O pedido fica pendente e o
    // usuário pode tentar de novo (mesmo order_nsu, sem novo pedido).
    throw new ProviderError('Tempo esgotado ao falar com a InfinitePay. Tente novamente em instantes.', true);
  }
  const data: any = await res.json().catch(() => ({}));
  const url = findUrl(data);
  if (!res.ok || !url) throw new ProviderError(`InfinitePay recusou a criação do link (HTTP ${res.status}).`);
  return url;
}

export interface PaymentCheck {
  success: boolean;
  paid: boolean;
  amount: number | null;
  paid_amount: number | null;
  installments: number | null;
  capture_method: string | null;
}

/** Consulta oficial. Exige order_nsu + transaction_nsu + slug (fatura). */
export async function paymentCheck(
  p: { orderNsu: string; transactionNsu: string; slug: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentCheck> {
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}/payment_check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: env('INFINITEPAY_HANDLE').replace(/^\$/, ''),
        order_nsu: p.orderNsu,
        transaction_nsu: p.transactionNsu,
        slug: p.slug,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProviderError('Tempo esgotado na consulta à InfinitePay.', true);
  }
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Consulta de pagamento falhou (HTTP ${res.status}).`);
  const num = (v: any) => (Number.isInteger(v) ? v : null);
  return {
    success: d.success === true,
    paid: d.paid === true,
    amount: num(d.amount),
    paid_amount: num(d.paid_amount),
    installments: num(d.installments),
    capture_method: typeof d.capture_method === 'string' ? d.capture_method : null,
  };
}

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/** Valida o formato documentado do webhook (campos desconhecidos são ignorados). */
export function parseWebhook(body: any) {
  if (!body || typeof body !== 'object') return null;
  const order_nsu = str(body.order_nsu, 100);
  const transaction_nsu = str(body.transaction_nsu, 100);
  const invoice_slug = str(body.invoice_slug, 100);
  if (!order_nsu || !transaction_nsu || !invoice_slug) return null;
  return {
    order_nsu,
    transaction_nsu,
    invoice_slug,
    amount: Number.isInteger(body.amount) ? body.amount : null,
    paid_amount: Number.isInteger(body.paid_amount) ? body.paid_amount : null,
    installments: Number.isInteger(body.installments) ? body.installments : null,
    capture_method: str(body.capture_method, 30),
    receipt_url: str(body.receipt_url, 500)?.startsWith('https://') ? body.receipt_url : null,
  };
}
