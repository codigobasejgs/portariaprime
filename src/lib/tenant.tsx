import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { rpc } from './api';
import { applyTheme, Branding } from './theme';
import type { TenantLink } from './session';
import { loadTenantInfo } from './tenant-data';
import type { UnitLabels } from './format';
import { Alert, Button, Spinner } from '../components/ui';

export interface TenantInfo {
  link: TenantLink;
  tenant: { id: string; slug: string; name: string; timezone: string; status: string };
  branding: Branding | null;
  overview: any | null; // subscription_overview
  unitLabels: UnitLabels;
  condoType: string;
}

export interface TenantState extends TenantInfo {
  reload: () => Promise<void>;
  can: (perm: 'team' | 'approve' | 'billing' | 'settings') => boolean;
  isStaff: boolean;
}

export const TenantContext = createContext<TenantState>(null!);
export const useTenant = () => useContext(TenantContext);

export function TenantProvider({ link, children }: { link: TenantLink; children: React.ReactNode }) {
  const [info, setInfo] = useState<Omit<TenantInfo, 'link'> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await loadTenantInfo(supabase, () => rpc('subscription_overview', { p_tenant: link.tenant_id }), link.tenant_id);
      if (generation.current !== current) return;
      setInfo(result);
      applyTheme(result.branding);
    } catch (e: any) {
      if (generation.current === current) setError(e.message);
    }
  }, [link.tenant_id]);

  useEffect(() => {
    setInfo(null);
    load();
    // Ao trocar/sair do condomínio: tema padrão e canais encerrados.
    return () => {
      generation.current++;
      applyTheme(null);
      supabase.removeAllChannels();
    };
  }, [load]);

  if (error) return <div className="p-6 space-y-4"><Alert tone="danger">{error}</Alert><Button onClick={load}>Tentar novamente</Button></div>;
  if (!info) return <Spinner label="Carregando condomínio…" />;
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
      // Nome único: mais de um componente pode ouvir a mesma tabela.
      .channel(`${table}:${tenantId}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `tenant_id=eq.${tenantId}` }, onChange)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [table, tenantId, onChange]);
}

/** Fallback do tempo real: recarrega ao voltar ao app e periodicamente enquanto a tela está visível. */
export function useRefreshWhileVisible(onRefresh: () => void, ms = 30000) {
  useEffect(() => {
    const vis = () => document.visibilityState === 'visible' && onRefresh();
    const id = setInterval(() => document.visibilityState === 'visible' && onRefresh(), ms);
    document.addEventListener('visibilitychange', vis); addEventListener('online', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); removeEventListener('online', vis); };
  }, [onRefresh, ms]);
}
