/**
 * POST /api/contact  { name, email, phone?, message, website }
 * Formulário comercial público. "website" é honeypot (bots preenchem).
 * Limite: 3 envios por IP a cada hora (hash do IP, sem guardar o IP).
 */
import { handler, json, readJson, HttpError, sha256Hex } from './_lib/http.js';
import { serviceClient } from './_lib/supabase.js';

export const POST = handler(async (request) => {
  const b = await readJson(request, 8192);
  if (b.website) return json({ ok: true }); // honeypot
  const s = (v: unknown, min: number, max: number) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
  const name = s(b.name, 2, 120), email = s(b.email, 5, 200), message = s(b.message, 5, 2000), phone = s(b.phone, 8, 30);
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !message) throw new HttpError(400, 'Preencha nome, e-mail válido e mensagem.');
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const ipHash = await sha256Hex(`contact:${ip}`);
  const svc = serviceClient();
  const { count } = await svc.from('contact_requests').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).gte('created_at', new Date(Date.now() - 3600_000).toISOString());
  if ((count || 0) >= 3) throw new HttpError(429, 'Recebemos suas mensagens. Aguarde nosso retorno.');
  const { error } = await svc.from('contact_requests').insert({ name, email: email.toLowerCase(), phone, message, ip_hash: ipHash });
  if (error) throw new Error(error.message);
  return json({ ok: true });
});
