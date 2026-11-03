import React, { useCallback, useEffect, useState } from 'react';
import { Download, Package, PackageCheck, Tablet, UserCheck } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { navigate, onLink, query } from '../../lib/router';
import { dateTime, download, STATUS_LABEL, toCsv, unitName } from '../../lib/format';
import { listAllPackages, listPackages, PackageRow } from '../../lib/packages';
import { Alert, Button, Card, Empty, Field, Input, Select, Spinner, toast } from '../../components/ui';
import { Analysis } from './PainelAnalise';

const ymd = (tz: string, delta = 0) => new Date(Date.now() + delta * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
const n = (v: unknown) => Number(v || 0).toLocaleString('pt-BR');

function Kpi({ label, value, hint, href, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: 'warning' | 'danger' }) {
  const body = (
    <>
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-3xl font-semibold mt-1 tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</p>
      {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
    </>
  );
  return href
    ? <a href={href} onClick={onLink} className="block rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent">{body}</a>
    : <Card>{body}</Card>;
}

export function PainelPage() {
  const [tab, setTab] = useState<'operacao' | 'analise'>(() => {
    const q = query('aba'); if (q === 'analise' || q === 'operacao') return q;
    try { return (localStorage.getItem('pp_dash_tab') as any) || 'operacao'; } catch { return 'operacao'; }
  });
  const pick = (v: 'operacao' | 'analise') => { setTab(v); try { localStorage.setItem('pp_dash_tab', v); } catch { /* ok */ } };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Visão geral</h1>
        <div role="tablist" className="inline-flex rounded-xl border border-line bg-surface p-1" data-tour="painel-abas">
          {(['operacao', 'analise'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={tab === v} onClick={() => pick(v)}
              className={`px-4 min-h-10 rounded-lg text-sm font-medium ${tab === v ? 'bg-primary text-primary-fg' : 'text-text hover:bg-surface-2'}`}>{v === 'operacao' ? 'Operação' : 'Análise'}</button>
          ))}
        </div>
      </div>
      {tab === 'operacao' ? <Operation /> : <Analysis />}
    </div>
  );
}

function Operation() {
  const t = useTenant();
  const base = `/c/${t.tenant.slug}`;
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => rpc('dashboard_operation', { p_tenant: t.tenant.id }).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>;
  if (!d) return <Spinner />;
  const a = d.attention;
  const occ = d.occupancy;
  const pct = occ.capacity ? Math.round((occ.used / occ.capacity) * 100) : null;
  // Prioridade: ação que bloqueia pessoas > risco físico > comunicação > administrativo.
  const items: [number, string, string, string][] = ([
    [a.access_requests, 'Solicitações de cadastro aguardando aprovação', 'Revisar', `${base}/pessoas?aba=solicitacoes`],
    [a.stale_packages, `Encomendas aguardando há mais de ${d.stale_hours} h`, 'Ver lista', `${base}/relatorios?status=PENDENTES&antigas=1`],
    [a.near_capacity, 'Locais de guarda com 85% ou mais de ocupação', 'Ver locais', `${base}/configuracoes?m=operacao`],
    [a.notification_failures, 'Avisos com falha final (WhatsApp, e-mail ou push)', 'Diagnóstico', `${base}/configuracoes?m=integracoes`],
    [a.receipt_failures, 'Comprovantes em PDF com falha', 'Diagnóstico', `${base}/configuracoes?m=integracoes`],
    [a.preregistered, 'Pré-registros antigos do totem a conferir', 'Conferir', `${base}/portaria`],
  ] as [number, string, string, string][]).filter(([c]) => c > 0);
  const pend = items.reduce((s, [c]) => s + c, 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-tour="painel-kpis">
        <Kpi label="Aguardando retirada agora" value={n(d.waiting_now)} hint={d.unstored_now ? `${d.unstored_now} sem local de guarda` : 'na portaria'} href={`${base}/relatorios?status=PENDENTES`} />
        <Kpi label={`Acima de ${d.stale_hours} h`} value={n(d.stale_now)} tone={d.stale_now ? 'warning' : undefined} hint="aguardando retirada" href={`${base}/relatorios?status=PENDENTES&antigas=1`} />
        <Kpi label="Ocupação dos locais" value={pct === null ? '—' : `${pct}%`} hint={occ.capacity ? `${n(occ.used)} de ${n(occ.capacity)} vagas` : 'Capacidade não definida'} href={`${base}/configuracoes?m=operacao`} />
        <Kpi label="Pendências que exigem ação" value={n(pend)} tone={pend ? 'danger' : undefined} hint={pend ? `${items.length} tipo(s), detalhados abaixo` : 'nada pendente'} />
      </div>

      <Card className="space-y-2" data-tour="painel-atencao">
        <p className="font-semibold">Precisa de atenção</p>
        {items.length === 0 ? <p className="text-sm text-muted">Nada pendente agora.</p> : (
          <ul className="divide-y divide-line">
            {items.map(([c, label, cta, href]) => (
              <li key={label} className="py-2 flex items-center justify-between gap-3 text-sm">
                <span><strong className="tabular-nums">{n(c)}</strong> · {label}</span>
                <a href={href} onClick={onLink} className="shrink-0 underline min-h-10 inline-flex items-center">{cta}</a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid lg:grid-cols-3 gap-3">
        <Card className="space-y-3">
          <p className="font-semibold">Hoje</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-muted text-xs">Recebidas</p><p className="text-2xl font-semibold tabular-nums">{n(d.received_today)}</p></div>
            <div><p className="text-muted text-xs">Retiradas</p><p className="text-2xl font-semibold tabular-nums">{n(d.picked_today)}</p></div>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {t.isStaff && <Button variant="secondary" onClick={() => navigate(`${base}/portaria`)}><Package className="w-4 h-4" /> Receber</Button>}
            {t.isStaff && <Button variant="secondary" onClick={() => navigate(`${base}/portaria?aba=entregar`)}><PackageCheck className="w-4 h-4" /> Entregar</Button>}
            {t.can('approve') && a.access_requests > 0 && <Button variant="secondary" onClick={() => navigate(`${base}/pessoas?aba=solicitacoes`)}><UserCheck className="w-4 h-4" /> Aprovar cadastros</Button>}
            {t.isStaff && <Button variant="ghost" onClick={() => navigate(`${base}/totem-equipe`)}><Tablet className="w-4 h-4" /> Abrir totem</Button>}
          </div>
        </Card>
        <Card className="lg:col-span-2" data-tour="painel-ocupacao">
          <p className="font-semibold mb-3">Ocupação por local</p>
          {d.locations.length === 0 ? <Empty title="Nenhum local de guarda">Cadastre estantes em Configurações › Operação e armazenamento.</Empty> : (
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
              {d.locations.slice(0, 10).map((o: any) => {
                const p = Math.round((o.used / o.capacity) * 100);
                return (
                  <li key={o.id}>
                    <div className="flex justify-between text-sm gap-2"><span className="truncate">{[o.rack, o.shelf].filter(Boolean).join(' › ') || o.code}{o.is_contingency ? ' (contingência)' : ''}</span><span className="tabular-nums shrink-0">{o.used}/{o.capacity}</span></div>
                    <div className="h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={`Ocupação ${o.code}: ${p}%`}>
                      <div className={`h-full ${p >= 100 ? 'bg-danger' : p >= 85 ? 'bg-warning' : 'bg-secondary'}`} style={{ width: `${Math.min(p, 100)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-2"><p className="font-semibold">Atividade recente</p><a href={`${base}/relatorios`} onClick={onLink} className="text-sm underline">Histórico completo</a></div>
        {d.recent.length === 0 ? <p className="text-sm text-muted">Nenhuma movimentação ainda.</p> : (
          <ul className="divide-y divide-line text-sm">
            {d.recent.map((r: any) => (
              <li key={r.id + r.kind} className="py-2 flex justify-between gap-2"><span className="truncate">{r.kind === 'picked' ? 'Retirada' : 'Recebida'} · {r.unit || '—'} · {r.carrier}</span><span className="text-muted shrink-0">{dateTime(r.at, t.tenant.timezone)}</span></li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-muted">Valores calculados no servidor, no fuso {d.timezone}. Atualizado em {dateTime(d.as_of, t.tenant.timezone)}.</p>
    </div>
  );
}

/** Relatórios: lista completa com filtros e exportação CSV (mesmos filtros). */
export function RelatoriosPage() {
  const t = useTenant();
  const tz = t.tenant.timezone;
  const oldOnly = query('antigas') === '1';
  const [from, setFrom] = useState(oldOnly ? '' : ymd(tz, -29));
  // “Antigas”: corta no servidor até 3 dias atrás; o corte exato de 72 h é aplicado na lista.
  const [to, setTo] = useState(oldOnly ? ymd(tz, -3) : ymd(tz));
  const [status, setStatus] = useState(query('status') || '');
  const [rows, setRows] = useState<PackageRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const cutoff = Date.now() - 72 * 3600_000;
  const filt = (r: PackageRow[]) => (oldOnly ? r.filter((p) => new Date(p.received_at).getTime() <= cutoff) : r);
  const params = { status: status || null, from: from || null, to: to || null };
  const load = async () => {
    setError(null); setRows(null);
    try { const r = await listPackages(t.tenant.id, { ...params, limit: 50 }); setRows(filt(r)); setMore(r.length === 50); }
    catch (e: any) { setError(e.message); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to, status, t.tenant.id]);
  const loadMore = async () => {
    const last = rows![rows!.length - 1];
    const r = await listPackages(t.tenant.id, { ...params, limit: 50 }, { at: last.received_at, id: last.id });
    setRows([...rows!, ...filt(r)]); setMore(r.length === 50);
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = filt(await listAllPackages(t.tenant.id, params));
      download(`encomendas-${t.tenant.slug}-${from || 'inicio'}-a-${to || 'hoje'}.csv`, toCsv(all.map((p) => ({
        ...p, unit: unitName(p.unit_block, p.unit_label), status_label: STATUS_LABEL[p.status], received: dateTime(p.received_at, tz), picked: dateTime(p.picked_up_at, tz),
      })), [['unit', 'Unidade'], ['carrier', 'Transportadora'], ['tracking_code', 'Rastreio'], ['recipient_name', 'Destinatário'], ['status_label', 'Situação'],
        ['received', 'Recebida em'], ['storage_code', 'Local'], ['picked', 'Retirada em'], ['picked_up_by_name', 'Retirada por'], ['pickup_method', 'Validação'], ['resolution_reason', 'Motivo da exceção']]));
    } catch (e: any) { toast.error(e.message); } finally { setExporting(false); }
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Relatórios</h1>
      {oldOnly && <Alert tone="info">Mostrando encomendas aguardando há mais de 72 h. <a className="underline" href={`/c/${t.tenant.slug}/relatorios`} onClick={onLink}>Limpar filtro</a></Alert>}
      <Card className="grid sm:grid-cols-4 gap-3 items-end" data-tour="painel-exportar">
        <Field label="De"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Até"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Situação">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todas</option><option value="PENDENTES">Pendentes</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="w-4 h-4" /> Exportar CSV</Button>
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nenhuma encomenda com esses filtros" /> : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-left text-muted"><tr><th className="py-2 px-4 sm:pl-0 font-medium">Unidade</th><th className="pr-3 font-medium">Transportadora</th><th className="pr-3 font-medium">Recebida</th><th className="pr-3 font-medium">Situação</th><th className="font-medium">Retirada por</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => (
                  <tr key={p.id}><td className="py-2 px-4 sm:pl-0">{unitName(p.unit_block, p.unit_label)}</td><td className="pr-3">{p.carrier}</td><td className="pr-3 whitespace-nowrap">{dateTime(p.received_at, tz)}</td><td className="pr-3">{STATUS_LABEL[p.status]}</td><td>{p.picked_up_by_name || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && <Button variant="ghost" className="mt-2" onClick={loadMore}>Carregar mais</Button>}
      </Card>
    </div>
  );
}
