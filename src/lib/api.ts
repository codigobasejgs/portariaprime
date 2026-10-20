import { supabase } from './supabase';

/** Mensagem amigável a partir de erro do Postgres/PostgREST/rede. */
export function friendly(e: unknown): string {
  const m = (e as any)?.message || String(e || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
  if (/JWT|jwt expired|invalid claim/i.test(m)) return 'Sua sessão expirou. Entre novamente.';
  if (/permission denied/i.test(m)) return 'Você não tem permissão para esta ação.';
  return m.replace(/^.*?ERROR:\s*/, '') || 'Algo deu errado. Tente novamente.';
}

/** Chama RPC e lança Error com mensagem amigável. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(friendly(error));
  return data as T;
}

/** Chama nossa API serverless com o JWT do usuário. */
export async function api<T = any>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(friendly(e));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(json.error || `Falha (${res.status}).`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}

export const newKey = () => crypto.randomUUID();
