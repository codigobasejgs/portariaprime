import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { HttpError } from './http.js';

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

/**
 * Cliente com service role — SOMENTE backend. Toda chamada que o usa precisa
 * de filtro/validação de tenant explícita (as RPCs de serviço já validam).
 */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), opts);
}

/**
 * Cliente que age COMO o usuário (JWT dele): RLS e RPCs aplicam vínculo ativo,
 * papel e estado comercial. É o padrão para qualquer ação de usuário.
 */
export function userClient(request: Request): { client: SupabaseClient; token: string } {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'Faça login novamente.');
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    ...opts,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client, token };
}

/** Valida o JWT no Supabase Auth e devolve o id do usuário. */
export async function requireUser(request: Request) {
  const { client, token } = userClient(request);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Sessão inválida ou expirada. Faça login novamente.');
  return { client, user: data.user };
}

/** Converte erro de RPC em resposta HTTP sem vazar detalhe interno. */
export function rpcError(error: { code?: string; message?: string } | null): never {
  const code = error?.code || '';
  const msg = error?.message || 'Falha na operação.';
  if (code === '42501') throw new HttpError(403, msg);
  if (code === 'P0002') throw new HttpError(404, msg);
  if (['P0001', '22023', '23505'].includes(code)) throw new HttpError(409, msg);
  console.error('[rpc]', code, msg);
  throw new HttpError(500, 'Falha na operação. Tente novamente.');
}
