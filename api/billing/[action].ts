/**
 * Rotas de cobrança numa única função (limite de funções do plano Vercel Hobby).
 * URLs inalteradas: /api/billing/checkout (POST), /api/billing/order (GET), /api/billing/reconcile (POST).
 * Arquivos com "_" não viram rota na Vercel.
 */
import { handler, HttpError } from '../_lib/http.js';
import { POST as checkout } from './_checkout.js';
import { GET as order } from './_order.js';
import { POST as reconcile } from './_reconcile.js';
import { contractAction } from './_contract.js';

const action = (r: Request) => new URL(r.url).pathname.split('/').pop();
const CONTRACT = new Set(['contract_accept', 'contract_verify', 'contract_code', 'contract_pdf', 'contract_resend', 'contract_sync', 'contract_signed_pdf', 'contract_original_pdf']);

export const POST = handler(async (request) => {
  const a = action(request);
  if (a === 'checkout') return checkout(request);
  if (a === 'reconcile') return reconcile(request);
  if (a && CONTRACT.has(a)) return contractAction(a, request);
  throw new HttpError(404, 'Ação desconhecida.');
});
export const GET = handler(async (request) => {
  if (action(request) === 'order') return order(request);
  throw new HttpError(404, 'Ação desconhecida.');
});
