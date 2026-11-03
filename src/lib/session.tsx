import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, configError } from './supabase';
import { friendly, rpc } from './api';
import { applyTheme } from './theme';
import { captureKioskNonce, isKiosk, kioskShift } from './kiosk-shift';

captureKioskNonce();

export interface TenantLink {
  tenant_id: string;
  slug: string;
  name: string;
  tenant_status: string;
  role: 'admin' | 'porteiro' | 'morador';
  permissions: string[];
  commercial_state: 'full' | 'grace' | 'restricted';
}

export interface Ctx {
  user_id: string;
  email: string;
  email_verified: boolean;
  platform_admin: boolean;
  platform_role?: 'owner' | 'support' | 'finance' | 'auditor' | null;
  tenants: TenantLink[];
}

interface SessionState {
  loading: boolean;
  session: Session | null;
  ctx: Ctx | null;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState>(null!);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(configError);

  const generation = useRef(0);
  const load = useCallback(async (s: Session | null) => {
    const current = ++generation.current;
    setSession(s);
    setCtx(null);
    if (!s) {
      setError(configError);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const context = await rpc<Ctx>('my_context');
      const { data: platform, error: platformError } = await supabase.rpc('platform_context');
      // Rollout incremental: apenas RPC ainda não instalada permite continuar sem papel global.
      if (platformError && platformError.code !== 'PGRST202') throw new Error(friendly(platformError));
      if (current !== generation.current) return;
      setCtx({ ...context, platform_role: platform?.role ?? null });
      void kioskShift('shift.start');
      setError(null);
    } catch (e: any) {
      if (current === generation.current) setError(e.message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (configError) {
      setLoading(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let currentUser: string | null | undefined;
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      // Ao voltar para a aba, o Supabase Auth reemite SIGNED_IN com a MESMA sessão. Tratar isso como login
      // novo zerava o contexto e remontava o app (formulários e filtros perdidos, tela piscando).
      // Mesmo usuário = só troca o token; usuário diferente, login ou logout = recarrega o contexto.
      const uid = s?.user?.id ?? null;
      if (event === 'TOKEN_REFRESHED' || ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && uid && uid === currentUser)) {
        return setSession(s);
      }
      currentUser = uid;
      clearTimeout(timer);
      // Consultas fora do callback evitam disputar o lock interno do Supabase Auth.
      timer = setTimeout(() => { void load(s); }, 0);
    });
    return () => { clearTimeout(timer); generation.current++; data.subscription.unsubscribe(); };
  }, [load]);

  const signOut = useCallback(async () => {
    // Encerra canais realtime e limpa tema/dados do condomínio anterior.
    await kioskShift('shift.end');   // antes de encerrar a sessão (precisa do JWT do operador)
    await supabase.removeAllChannels();
    try {
      const sub = await (await navigator.serviceWorker?.getRegistration())?.pushManager?.getSubscription();
      if (sub) await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    } catch { /* sem push neste navegador */ }
    // Sai só deste aparelho; o padrão (global) derrubava a sessão de todos os outros.
    await supabase.auth.signOut({ scope: 'local' });
    applyTheme(null);
    try { const k = isKiosk() ? sessionStorage.getItem('pp_kiosk_shift') : null; sessionStorage.clear(); if (k) sessionStorage.setItem('pp_kiosk_shift', k); } catch { /* sem storage */ }
    setCtx(null);
  }, []);

  return (
    <SessionContext.Provider value={{ loading, session, ctx, error, refresh: () => load(session), signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
