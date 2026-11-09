import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc } from '../lib/api';
import { navigate, onLink } from '../lib/router';
import { useRealtime, useRefreshWhileVisible, useTenant } from '../lib/tenant';
import { dateTime } from '../lib/format';
import { Button, Spinner } from './ui';

export interface Notif { id: string; kind: string; title: string; body: string; package_id: string | null; read_at: string | null; created_at: string }

/** Destino de cada aviso (sempre dentro do condomínio; a página revalida o acesso). */
export function notifTarget(base: string, n: Notif) {
  if (n.kind === 'access_request') return `${base}/pessoas?aba=solicitacoes`;
  if (n.kind === 'package_rejected') return `${base}/portaria?aba=buscar`;
  if (n.kind === 'ops_alert') return `${base}/configuracoes?m=integracoes`;
  if (n.kind === 'trial_reminder') return `${base}/configuracoes?m=plano`;
  if (n.kind === 'package_picked_up' && n.package_id) return `${base}/comprovante?p=${n.package_id}`;
  if (n.kind === 'package_received' && n.package_id) return `${base}/encomenda?p=${n.package_id}`;
  return `${base}/avisos`;
}

/** Contagem e lista do próprio usuário neste condomínio (leitura individual). */
export function useNotifications(onlyUnread = false) {
  const t = useTenant();
  const [data, setData] = useState<{ unread: number; items: Notif[] } | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try { setData(await rpc('my_notifications', { p_tenant: t.tenant.id, p_unread: onlyUnread, p_before: null, p_limit: 20 })); setError(false); }
    catch { setError(true); }
  }, [t.tenant.id, onlyUnread]);
  useEffect(() => { void load(); }, [load]);
  useRealtime('notifications', t.tenant.id, load);
  useRefreshWhileVisible(load, 60000);
  const markRead = async (id?: string) => {
    let q = supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('tenant_id', t.tenant.id).is('read_at', null);
    if (id) q = q.eq('id', id);
    await q;
    await load();
  };
  return { data, error, load, markRead };
}

export function NotificationBell() {
  const t = useTenant();
  const base = `/c/${t.tenant.slug}`;
  const [open, setOpen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const { data, error, load, markRead } = useNotifications(onlyUnread);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    const click = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', key); document.addEventListener('mousedown', click);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', click); };
  }, [open]);
  const unread = data?.unread || 0;
  const go = async (n: Notif) => { if (!n.read_at) await markRead(n.id); setOpen(false); navigate(notifTarget(base, n)); };
  return (
    <div className="relative">
      <button ref={btn} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog"
        aria-label={unread ? `Notificações, ${unread} não lidas` : 'Notificações'} className="relative p-2 rounded-xl hover:bg-surface-2 min-h-11 min-w-11 grid place-items-center">
        <Bell className="w-5 h-5" aria-hidden />
        {unread > 0 && <span className="absolute top-1 right-1 min-w-5 h-5 px-1 rounded-full bg-danger text-white text-[11px] font-semibold grid place-items-center">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div ref={panel} role="dialog" aria-label="Notificações"
          className="fixed inset-x-2 top-16 sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-96 z-50 rounded-2xl border border-line bg-surface shadow-lg max-h-[75vh] flex flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="font-semibold">Notificações</p>
            <div className="flex items-center gap-1 text-sm">
              <button className={`px-2 py-1 rounded-lg ${!onlyUnread ? 'bg-surface-2 font-medium' : ''}`} onClick={() => setOnlyUnread(false)}>Todas</button>
              <button className={`px-2 py-1 rounded-lg ${onlyUnread ? 'bg-surface-2 font-medium' : ''}`} onClick={() => setOnlyUnread(true)}>Não lidas</button>
            </div>
          </div>
          <div className="overflow-y-auto">
            {error ? <div className="p-4 text-sm space-y-2"><p>Não foi possível carregar.</p><Button variant="secondary" onClick={load}>Tentar novamente</Button></div>
              : !data ? <Spinner /> : data.items.length === 0 ? <p className="p-6 text-sm text-muted text-center">{onlyUnread ? 'Tudo lido.' : 'Nenhuma notificação.'}</p> : (
                <ul className="divide-y divide-line">
                  {data.items.map((n) => (
                    <li key={n.id}><button onClick={() => go(n)} className="w-full text-left px-4 py-3 hover:bg-surface-2 flex gap-3">
                      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${n.read_at ? 'bg-transparent' : 'bg-primary'}`} aria-label={n.read_at ? undefined : 'não lida'} />
                      <span className="min-w-0"><span className="block text-sm font-medium">{n.title}</span>
                        <span className="block text-xs text-muted line-clamp-2">{n.body}</span>
                        <span className="block text-[11px] text-muted mt-1">{dateTime(n.created_at, t.tenant.timezone)}</span></span>
                    </button></li>
                  ))}
                </ul>
              )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-sm">
            <button className="inline-flex items-center gap-1 min-h-10 disabled:opacity-50" disabled={!unread} onClick={() => markRead()}><CheckCheck className="w-4 h-4" /> Marcar todas como lidas</button>
            <a href={`${base}/avisos`} onClick={(e) => { onLink(e); setOpen(false); }} className="underline min-h-10 inline-flex items-center">Ver todas</a>
          </div>
        </div>
      )}
    </div>
  );
}
