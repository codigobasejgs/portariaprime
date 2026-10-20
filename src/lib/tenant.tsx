import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { rpc } from './api';
import { applyTheme, Branding } from './theme';
import type { TenantLink } from './session';

export interface TenantInfo {
  link: TenantLink;
  tenant: { id: string; slug: string; name: string; timezone: string; status: string };
  branding: Branding | null;
  overview: any | null; // subscription_overview
}

interface TenantState extends TenantInfo {
  reload: () => Promise<void>;
  can: (perm: 'team' | 'approve' | 'billing' | 'settings') => boolean;
  isStaff: boolean;
}

const TenantContext = createContext<TenantState>(null!);
export const useTenant = () => useContext(TenantContext);

export function TenantProvider({ link, children }: { link: TenantLink; children: React.ReactNode }) {
  const [info, setInfo] = useState<Omit<TenantInfo, 'link'> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ data: tenant, error: te }, { data: branding }, overview] = await Promise.all([
        supabase.from('tenants').select('id, slug, name, timezone, status').eq('id', link.tenant_id).single(),
        supabase.from('tenant_branding').select('*').eq('tenant_id', link.tenant_id).maybeSingle(),
        rpc('subscription_overview', { p_tenant: link.tenant_id }).catch(() => null),
      ]);
      if (te || !tenant) throw new Error('Condomínio indisponível.');
      setInfo({ tenant, branding, overview });
      applyTheme(branding);
    } catch (e: any) {
      setError(e.message);
    }
  }, [link.tenant_id]);

  useEffect(() => {
    setInfo(null);
    load();
    // Ao trocar/sair do condomínio: tema padrão e canais encerrados.
    return () => {
      applyTheme(null);
      supabase.removeAllChannels();
    };
  }, [load]);

  if (error) return <div className="p-6 text-danger">{error}</div>;
  if (!info) return <div className="p-10 text-center text-muted">Carregando condomínio…</div>;
  return (
    <TenantContext.Provider value={{
      ...info, link, reload: load,
      can: (p) => link.role === 'admin' && link.permissions.includes(p),
      isStaff: link.role === 'admin' || link.role === 'porteiro',
    }}>
      {children}
    </TenantContext.Provider>
  );
}

/** Assina mudanças em tabelas do condomínio (RLS + filtro por tenant). */
export function useRealtime(table: 'packages' | 'notifications', tenantId: string, onChange: () => void) {
  useEffect(() => {
    const ch = supabase
      .channel(`${table}:${tenantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `tenant_id=eq.${tenantId}` }, onChange)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [table, tenantId, onChange]);
}
