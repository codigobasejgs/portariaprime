import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Configuração ausente é erro visível — nunca fallback para um projeto antigo. */
export const configError: string | null =
  !url || !anonKey ? 'VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY não estão configuradas neste ambiente.' : null;

export const supabase = createClient(url || 'http://config-ausente.invalid', anonKey || 'config-ausente', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
