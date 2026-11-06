import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Bell, Building2, ChevronsLeft, ChevronsRight, CircleUser, HelpCircle, History, Home } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { onLink } from '../../lib/router';
import { publicLogoUrl } from '../../lib/theme';
import { unitName } from '../../lib/format';
import { useNotifications } from '../../components/NotificationBell';
import { Alert, Button, Spinner } from '../../components/ui';

export interface Unit { id: string; block: string | null; label: string; since?: string }
interface ResidentState {
  base: string; name: string | null; email: string; units: Unit[];
  unit: string | null; setUnit: (id: string | null) => void;
  unread: number; refreshUnread: () => Promise<void>; reloadProfile: () => Promise<void>;
}
const Ctx = createContext<ResidentState>(null!);
export const useResident = () => useContext(Ctx);

/** Área do morador → item da navegação ativo. */
// Detalhe da encomenda é aberto de vários lugares: nenhum destino fica marcado por engano.
const ACTIVE: Record<string, string> = { inicio: 'inicio', historico: 'historico', comprovante: 'historico', notificacoes: 'notificacoes', conta: 'conta', ajuda: 'conta' };
/** Artigo de ajuda contextual por área. */
export const HELP_FOR: Record<string, string> = { inicio: 'morador-chegou', encomenda: 'morador-retirar', historico: 'morador-comprovante', notificacoes: 'morador-notificacoes', conta: 'morador-notificacoes' };

export function ResidentShell({ area, children }: { area: string; children: React.ReactNode }) {
  const t = useTenant();
  const base = `/c/${t.tenant.slug}`;
  const [profile, setProfile] = useState<{ full_name: string | null; email: string; units: Unit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefKey = `pp_unit:${t.tenant.id}`;
  const [unit, setUnitState] = useState<string | null>(() => { try { return sessionStorage.getItem(prefKey); } catch { return null; } });
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('pp_res_nav') === '1'; } catch { return false; } });
  const { data, load: refreshUnread } = useNotifications(false);
  const unread = data?.unread || 0;

  const reloadProfile = useCallback(async () => {
    setError(null);
    try { setProfile(await rpc('resident_profile', { p_tenant: t.tenant.id })); } catch (e: any) { setError(e.message); }
  }, [t.tenant.id]);
  useEffect(() => { void reloadProfile(); }, [reloadProfile]);

  const units = profile?.units || [];
  // Unidade escolhida que deixou de ser do usuário volta para "todas".
  const current = unit && units.some((u) => u.id === unit) ? unit : null;
  const setUnit = (id: string | null) => { setUnitState(id); try { id ? sessionStorage.setItem(prefKey, id) : sessionStorage.removeItem(prefKey); } catch { /* ok */ } };
  const toggle = () => setCollapsed((v) => { try { localStorage.setItem('pp_res_nav', v ? '0' : '1'); } catch { /* ok */ } return !v; });

  const name = t.branding?.display_name || t.tenant.name;
  const logo = publicLogoUrl(t.branding?.logo_path);
  const active = ACTIVE[area] || '';
  const items: [string, string, React.ElementType, number?][] = [
    ['inicio', 'Início', Home], ['historico', 'Histórico', History], ['notificacoes', 'Notificações', Bell, unread], ['conta', 'Minha conta', CircleUser],
  ];
  const badge = (n?: number, cls = '') => n ? <span className={`min-w-5 h-5 px-1 rounded-full bg-danger text-white text-[11px] font-semibold grid place-items-center ${cls}`} aria-hidden>{n > 99 ? '99+' : n}</span> : null;
  const label = (l: string, n?: number) => (n ? `${l}, ${n} não lidas` : l);

  return (
    <div className={`min-h-dvh md:grid ${collapsed ? 'md:grid-cols-[80px_1fr]' : 'md:grid-cols-[80px_1fr] lg:grid-cols-[232px_1fr]'}`}>
      {/* Tablet: trilho; desktop: barra lateral recolhível. Celular: barra inferior. */}
      <aside className="hidden md:flex flex-col sticky top-0 h-dvh bg-surface border-r border-line p-3 gap-1">
        <nav aria-label="Principal" className="flex flex-col gap-1">
          {items.map(([id, l, Icon, n]) => {
            const on = active === id;
            return (
              <a key={id} href={`${base}/${id}`} onClick={onLink} aria-current={on ? 'page' : undefined} aria-label={label(l, n)} title={l}
                className={`relative flex items-center rounded-xl min-h-12 font-medium transition-colors ${on ? 'bg-primary text-primary-fg' : 'text-text hover:bg-surface-2'}
                  flex-col justify-center gap-0.5 text-[11px] ${collapsed ? '' : 'lg:flex-row lg:justify-start lg:gap-3 lg:px-3 lg:text-sm'}`}>
                <Icon className="w-5 h-5 shrink-0" aria-hidden />
                <span className={collapsed ? 'sr-only' : ''}>{l}</span>
                {badge(n, `absolute top-1 right-1 ${collapsed ? '' : 'lg:static lg:ml-auto'}`)}
              </a>
            );
          })}
        </nav>
        <button onClick={toggle} className="mt-auto hidden lg:flex items-center justify-center min-h-10 rounded-xl text-muted hover:bg-surface-2" aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}>
          {collapsed ? <ChevronsRight className="w-5 h-5" /> : <ChevronsLeft className="w-5 h-5" />}
        </button>
      </aside>

      <div className="min-w-0 flex flex-col min-h-dvh">
        <header className="sticky top-0 z-30 bg-surface border-b border-line pt-[env(safe-area-inset-top)]">
          <div className="max-w-3xl mx-auto flex items-center gap-2 px-4 min-h-14">
            {logo ? <img src={logo} alt="" className="h-9 w-9 rounded-lg object-contain bg-surface-2 shrink-0" />
              : <span className="h-9 w-9 rounded-lg bg-primary text-primary-fg grid place-items-center shrink-0"><Building2 className="w-5 h-5" aria-hidden /></span>}
            <div className="min-w-0 flex-1">
              <p className="font-semibold truncate leading-tight" title={name}>{name}</p>
              {units.length === 1 && <p className="text-xs text-muted truncate">{unitName(units[0].block, units[0].label, t.unitLabels)}</p>}
              {units.length > 1 && (
                <select aria-label="Unidade" value={current || ''} onChange={(e) => setUnit(e.target.value || null)}
                  className="text-xs text-muted bg-transparent max-w-full -ml-1 min-h-6 rounded focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="">Todas as minhas unidades</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}
                </select>
              )}
            </div>
            <a href={`${base}/ajuda${HELP_FOR[area] ? `?artigo=${HELP_FOR[area]}` : ''}`} onClick={onLink} aria-label="Ajuda desta tela" title="Ajuda"
              className="min-h-11 min-w-11 grid place-items-center rounded-xl text-muted hover:bg-surface-2"><HelpCircle className="w-5 h-5" aria-hidden /></a>
            <a href={`${base}/notificacoes`} onClick={onLink} aria-label={label('Notificações', unread)}
              className="relative min-h-11 min-w-11 grid place-items-center rounded-xl hover:bg-surface-2"><Bell className="w-5 h-5" aria-hidden />{badge(unread, 'absolute top-1 right-0.5')}</a>
          </div>
        </header>

        <main className="w-full max-w-3xl mx-auto px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-10 flex-1">
          {error ? <div className="space-y-3"><Alert tone="danger">Não foi possível carregar seus dados agora. {error}</Alert><Button onClick={reloadProfile}>Tentar novamente</Button></div>
            : !profile ? <Spinner />
            : <Ctx.Provider value={{ base, name: profile.full_name, email: profile.email, units, unit: current, setUnit, unread, refreshUnread, reloadProfile }}>{children}</Ctx.Provider>}
        </main>

        <nav aria-label="Principal" className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-surface border-t border-line pb-[env(safe-area-inset-bottom)]">
          <div className="grid grid-cols-4">
            {items.map(([id, l, Icon, n]) => {
              const on = active === id;
              return (
                <a key={id} href={`${base}/${id}`} onClick={onLink} aria-current={on ? 'page' : undefined} aria-label={label(l, n)}
                  className={`relative flex flex-col items-center justify-center gap-0.5 min-h-16 text-[11px] font-medium ${on ? 'text-primary' : 'text-muted'}`}>
                  <span className={`grid place-items-center h-7 w-12 rounded-full ${on ? 'bg-primary/10' : ''}`}><Icon className="w-5 h-5" aria-hidden /></span>
                  <span>{l}</span>
                  {badge(n, 'absolute top-1.5 left-1/2 ml-2')}
                </a>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
