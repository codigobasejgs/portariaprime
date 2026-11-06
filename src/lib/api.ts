import { supabase } from './supabase';
import { callApi, friendly } from './call-api';
import { DEMO } from '../demo/mode';
import { demoApi } from '../demo/api';

export { friendly };

/** Chama RPC e lança Error com mensagem amigável. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(friendly(error));
  return data as T;
}

/** Chama nossa API serverless com o JWT do usuário. */
export function api<T = any>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return DEMO ? demoApi<T>(path, body) : callApi<T>(supabase.auth, path, body, method);
}

export const newKey = () => crypto.randomUUID();
