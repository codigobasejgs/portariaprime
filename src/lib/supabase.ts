import { createClient } from '@supabase/supabase-js';
import { DEMO } from '../demo/mode';
import { createDemoClient } from '../demo/client';

const env = import.meta.env;
// Aceita os nomes do Vite e os que a integração Supabase da Vercel cria (NEXT_PUBLIC_*).
export const supabaseUrl: string | undefined = DEMO ? undefined : (env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL);
const anonKey: string | undefined = DEMO ? undefined :
  (env.VITE_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** Configuração ausente é erro visível — nunca fallback para um projeto antigo. */
export const configError: string | null = DEMO ? null : (!supabaseUrl || !anonKey
  ? 'Configuração do Supabase ausente: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (ou NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) e refaça o deploy.'
  : null);

export const supabase = DEMO
  ? (createDemoClient() as any)
  : createClient(supabaseUrl || 'http://config-ausente.invalid', anonKey || 'config-ausente', {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
