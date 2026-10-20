import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, configError } from './supabase';
import { rpc } from './api';
import { applyTheme } from './theme';

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
      if (current !== generation.current) return;
      setCtx(context);
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
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'TOKEN_REFRESHED') return setSession(s);
      clearTimeout(timer);
      // Consultas fora do callback evitam disputar o lock interno do Supabase Auth.
      timer = setTimeout(() => { void load(s); }, 0);
    });
    return () => { clearTimeout(timer); generation.current++; data.subscription.unsubscribe(); };
  }, [load]);

  const signOut = useCallback(async () => {
    // Encerra canais realtime e limpa tema/dados do condomínio anterior.
    await supabase.removeAllChannels();
    await supabase.auth.signOut();
    applyTheme(null);
    try { sessionStorage.clear(); } catch { /* sem storage */ }
    setCtx(null);
  }, []);

  return (
    <SessionContext.Provider value={{ loading, session, ctx, error, refresh: () => load(session), signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
