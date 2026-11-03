import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LifeBuoy, BarChart3, Building2, ChevronsLeft, ChevronsRight, CircleUser, HelpCircle, LayoutDashboard, LogOut, Menu, Package, Settings, Shield, Smartphone, Users, X } from 'lucide-react';
import { useSession } from '../../lib/session';
import { useRealtime, useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { supabase } from '../../lib/supabase';
import { navigate, onLink } from '../../lib/router';
import { publicLogoUrl } from '../../lib/theme';
import { Alert } from '../../components/ui';
import { NotificationBell } from '../../components/NotificationBell';
import { useTour } from '../../components/TourGuide';
import { articleFor } from '../../lib/help';
import { loadProgress, saveProgress, toursFor } from '../../lib/tours';

interface NavItem { area: string; label: string; icon: React.ElementType; show: boolean; match?: string[]; badge?: number }

/** Solicitações de cadastro pendentes (só quem aprova); atualiza com o aviso em tempo real e ao voltar à tela. */
function usePendingAccess(tenantId: string, enabled: boolean) {
  const [n, setN] = useState(0);
  const load = useCallback(() => {
    if (enabled) void supabase.rpc('access_requests_pending_count', { p_tenant: tenantId }).then(({ data }) => setN(Number(data) || 0));
  }, [tenantId, enabled]);
  useEffect(() => { load(); addEventListener('pp:access-requests', load); return () => removeEventListener('pp:access-requests', load); }, [load]);
  useRealtime('notifications', tenantId, load);
  useRefreshWhileVisible(load, 60000);
  return n;
}

const TITLES: Record<string, string> = {
  painel: 'Visão geral', portaria: 'Encomendas', 'totem-equipe': 'Totem da portaria', pessoas: 'Unidades e moradores', relatorios: 'Relatórios',
  configuracoes: 'Configurações', assinatura: 'Plano e assinatura', suporte: 'Suporte', ajuda: 'Ajuda', morador: 'Minhas encomendas', avisos: 'Notificações',
  aplicativo: 'Meu aplicativo e notificações', comprovante: 'Comprovante',
};

/** “Ajuda desta tela” + oferta do tutorial no primeiro acesso à área (sem obrigar). */
function ScreenHelp({ area, base }: { area: string; base: string }) {
  const t = useTenant();
  const { ctx } = useSession();
  const { start, running } = useTour();
  const role = t.link.role;
  const article = articleFor(area, role);
  const tour = toursFor(role, (p) => t.can(p as any)).find((x) => x.steps[0].area === area);
  const [progress, setProgress] = useState(() => loadProgress(ctx!.user_id, t.tenant.id));
  if (area === 'ajuda' || !article) return null;
  const offer = tour && progress[tour.id] === undefined && !running;
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 text-sm">
      {offer && (
        <span className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5">
          Primeira vez aqui?
          <button className="font-semibold underline min-h-9" onClick={() => start(tour, base, ctx!.user_id, t.tenant.id)}>Fazer o tutorial</button>
          <button className="text-muted underline min-h-9" onClick={() => { saveProgress(ctx!.user_id, t.tenant.id, tour.id, 'skipped'); setProgress(loadProgress(ctx!.user_id, t.tenant.id)); }}>Agora não</button>
        </span>
      )}
      <a href={`${base}/ajuda?artigo=${article.slug}`} onClick={onLink} className="inline-flex items-center gap-1 text-muted hover:text-text min-h-9" aria-label="Ajuda desta tela"><HelpCircle className="w-4 h-4" aria-hidden /><span className="hidden sm:inline">Ajuda desta tela</span></a>
    </div>
  );
}

function loadCollapsed() { try { return localStorage.getItem('pp_nav_collapsed') === '1'; } catch { return false; } }

/** Menu da conta: app deste aparelho, troca de condomínio, administração global (se houver), sair. */
function AccountMenu({ base }: { base: string }) {
  const t = useTenant();
  const { ctx, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const others = Array.from(new Map((ctx?.tenants || []).filter((x) => x.tenant_id !== t.link.tenant_id).map((x) => [x.tenant_id, x])).values());
  const item = 'flex items-center gap-2 w-full text-left rounded-lg px-3 min-h-11 text-sm hover:bg-surface-2';
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu" aria-label="Conta" className="p-2 rounded-xl hover:bg-surface-2 min-h-11 min-w-11 grid place-items-center"><CircleUser className="w-5 h-5" /></button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-72 max-w-[calc(100vw-1rem)] rounded-2xl border border-line bg-surface shadow-lg p-2">
          <p className="px-3 py-2 text-xs text-muted truncate">{ctx?.email}</p>
          <a role="menuitem" href={`${base}/aplicativo`} onClick={(e) => { onLink(e); setOpen(false); }} className={item}><Smartphone className="w-4 h-4" /> Meu aplicativo e notificações</a>
          {others.length > 0 && <>
            <p className="px-3 pt-2 text-xs text-muted">Trocar de condomínio</p>
            {others.map((o) => <a key={o.tenant_id} role="menuitem" href={`/c/${o.slug}`} onClick={(e) => { onLink(e); setOpen(false); }} className={item}><Building2 className="w-4 h-4" /> <span className="truncate">{o.name}</span></a>)}
          </>}
          {(ctx?.platform_admin || ctx?.platform_role) && <a role="menuitem" href="/admin" onClick={(e) => { onLink(e); setOpen(false); }} className={item}><Shield className="w-4 h-4" /> Administração da plataforma</a>}
          <button role="menuitem" className={`${item} text-danger`} onClick={async () => { await signOut(); navigate('/entrar', true); }}><LogOut className="w-4 h-4" /> Sair</button>
        </div>
      )}
    </div>
  );
}

export function TenantShell({ area, children }: { area: string; children: React.ReactNode }) {
  const t = useTenant();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const base = `/c/${t.tenant.slug}`;
  const role = t.link.role;
  const admin = role === 'admin';
  const pending = usePendingAccess(t.tenant.id, t.can('approve'));
  const items: NavItem[] = [
    { area: 'painel', label: 'Visão geral', icon: LayoutDashboard, show: admin },
    { area: 'portaria', label: 'Encomendas', icon: Package, show: t.isStaff, match: ['portaria', 'totem-equipe'] },
    { area: 'pessoas', label: 'Unidades e moradores', icon: Users, show: t.can('approve') || admin, badge: pending },
    { area: 'relatorios', label: 'Relatórios', icon: BarChart3, show: admin },
  ];
  const bottom: NavItem[] = [
    { area: 'configuracoes', label: 'Configurações', icon: Settings, show: t.can('settings') || t.can('billing') || t.can('team'), match: ['configuracoes', 'assinatura'] },
    { area: 'suporte', label: 'Suporte', icon: LifeBuoy, show: t.isStaff },
    { area: 'ajuda', label: 'Ajuda', icon: HelpCircle, show: true },
  ];
  const name = t.branding?.display_name || t.tenant.name;
  const logo = publicLogoUrl(t.branding?.logo_path);
  const state = t.overview?.commercial_state ?? t.link.commercial_state;

  // Drawer: foco no primeiro item; Escape fecha e devolve o foco ao botão.
  useEffect(() => {
    if (!open) return;
    drawer.current?.querySelector<HTMLElement>('a,button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); menuBtn.current?.focus(); } };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  const toggleCollapsed = () => setCollapsed((v) => { try { localStorage.setItem('pp_nav_collapsed', v ? '0' : '1'); } catch { /* ok */ } return !v; });

  const link = (i: NavItem, mini: boolean) => {
    const active = (i.match || [i.area]).includes(area);
    return (
      <a key={i.area} href={`${base}/${i.area}`} onClick={(e) => { onLink(e); setOpen(false); }} aria-current={active ? 'page' : undefined}
        title={mini ? i.label : undefined} aria-label={mini || i.badge ? `${i.label}${i.badge ? ` (${i.badge} pendente${i.badge > 1 ? 's' : ''})` : ''}` : undefined}
        className={`relative flex items-center gap-3 rounded-xl ${mini ? 'justify-center' : 'px-3'} min-h-11 text-sm font-medium transition-colors ${active ? 'bg-primary text-primary-fg' : 'text-text hover:bg-surface-2'}`}>
        <i.icon className="w-5 h-5 shrink-0" aria-hidden />{!mini && <span className="truncate flex-1">{i.label}</span>}
        {!!i.badge && <span aria-hidden data-testid={`badge-${i.area}`} className={`${mini ? 'absolute top-1 right-1' : ''} min-w-5 h-5 px-1 rounded-full bg-danger text-white text-[11px] font-semibold grid place-items-center`}>{i.badge > 99 ? '99+' : i.badge}</span>}
      </a>
    );
  };
  const nav = (mini: boolean) => (
    <div className="flex flex-col flex-1 min-h-0">
      <div className={`flex items-center gap-3 min-w-0 ${mini ? 'justify-center' : ''}`} title={mini ? name : undefined}>
        {logo ? <img src={logo} alt={mini ? name : ''} className="h-10 w-10 rounded-lg object-contain bg-surface-2 shrink-0" />
          : <span className="h-10 w-10 rounded-lg bg-primary text-primary-fg grid place-items-center shrink-0" aria-label={mini ? name : undefined}><Building2 className="w-5 h-5" /></span>}
        {!mini && <div className="min-w-0"><p className="font-semibold truncate" title={name}>{name}</p><p className="text-xs text-muted">{admin ? 'Administração' : role === 'porteiro' ? 'Portaria' : 'Morador'}</p></div>}
      </div>
      <nav aria-label="Principal" className="mt-6 space-y-1 overflow-y-auto flex-1 min-h-0">{items.filter((i) => i.show).map((i) => link(i, mini))}</nav>
      <div className="pt-3 mt-3 border-t border-line space-y-1">{bottom.filter((i) => i.show).map((i) => link(i, mini))}
        {!mini && <p className="text-[11px] text-muted pt-2 px-3">Tecnologia Portaria Prime</p>}</div>
    </div>
  );

  return (
    <div className={`min-h-dvh lg:grid ${collapsed ? 'lg:grid-cols-[72px_1fr]' : 'lg:grid-cols-[248px_1fr]'}`}>
      <aside className="hidden lg:flex flex-col sticky top-0 h-dvh bg-surface border-r border-line p-3">
        {nav(collapsed)}
        <button onClick={toggleCollapsed} className="mt-2 flex items-center justify-center min-h-10 rounded-xl text-muted hover:bg-surface-2" aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}>
          {collapsed ? <ChevronsRight className="w-5 h-5" /> : <ChevronsLeft className="w-5 h-5" />}
        </button>
      </aside>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => { setOpen(false); menuBtn.current?.focus(); }} />
          <aside ref={drawer} className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface p-4 flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))]">
            <button onClick={() => { setOpen(false); menuBtn.current?.focus(); }} className="self-end p-2 -mt-1 mb-1 min-h-11 min-w-11 grid place-items-center" aria-label="Fechar menu"><X /></button>
            {nav(false)}
          </aside>
        </div>
      )}
      <div className="min-w-0 flex flex-col" inert={open ? true : undefined}>
        <header className="sticky top-0 z-30 flex items-center gap-1 border-b border-line bg-surface px-2 sm:px-4 min-h-14 pt-[env(safe-area-inset-top)]">
          <button ref={menuBtn} onClick={() => setOpen(true)} aria-label="Abrir menu" className="lg:hidden min-h-11 min-w-11 grid place-items-center"><Menu /></button>
          <p className="font-semibold truncate flex-1 px-1">{TITLES[area] || name}</p>
          <NotificationBell />
          <AccountMenu base={base} />
        </header>
        <main className="w-full max-w-6xl mx-auto px-4 py-6 space-y-4 flex-1">
          {/* Só bloqueio real aparece aqui; o prazo do teste fica em Plano e assinatura e no sino. */}
          {t.isStaff && state === 'restricted' && (
            <Alert tone="danger">Assinatura inativa: novos recebimentos estão bloqueados. Consulta, exportação e retirada de encomendas já guardadas continuam liberadas.{t.can('billing') && <> <a className="underline" href={`${base}/configuracoes?m=plano`} onClick={onLink}>Regularizar</a></>}</Alert>
          )}
          {t.isStaff && state === 'grace' && t.can('billing') && (
            <Alert tone="warning">O acesso pago terminou. Período de carência: regularize para não bloquear novos recebimentos. <a className="underline" href={`${base}/configuracoes?m=plano`} onClick={onLink}>Pagar assinatura</a></Alert>
          )}
          <ScreenHelp area={area} base={base} />
          {children}
        </main>
      </div>
    </div>
  );
}
