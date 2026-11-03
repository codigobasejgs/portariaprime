import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Lightbulb, RotateCcw } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { dateTime, download, STATUS_LABEL } from '../../lib/format';
import {
  bucketLabel, cleanFilters, exportCsv, exportName, exportTables, exportXlsx, Filters, hours, insights, num, pct, periodLabel,
  Preset, PRESETS, presetRange, rangeError, todayIn, unitLabel,
} from '../../lib/dashboard';
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, toast } from '../../components/ui';

const DOW = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const CH: Record<string, string> = { whatsapp: 'WhatsApp', email: 'E-mail', push: 'Push' };
const STATE: Record<string, string> = { pending: 'Pendente', accepted: 'Aceito pelo provedor', delivered: 'Entregue (confirmado)', failed_retryable: 'Falha (vai tentar de novo)', failed_final: 'Falha final', disabled: 'Desativado/sem canal' };
const GRAN: Record<string, string> = { day: 'por dia', week: 'por semana', month: 'por mês' };

/** Variação sem base (anterior = 0) aparece como texto, nunca como infinito. invert: subir é ruim (ex.: tempo). */
function Change({ value, previous, change, invert, fmt = num }: { value: number | null; previous: number | null; change: number | null; invert?: boolean; fmt?: (v: any) => string }) {
  if (change === null) return <span>{!previous && value ? 'Sem base de comparação' : 'Igual ao período anterior'}</span>;
  if (change === 0) return <span>Igual ao período anterior ({fmt(previous)})</span>;
  const up = change > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const good = invert ? !up : up;
  return <span className="inline-flex items-center gap-1"><span className={`inline-flex items-center font-semibold ${good ? 'text-success' : 'text-danger'}`}><Icon className="w-3 h-3" aria-hidden /><span className="sr-only">{up ? 'Aumento de' : 'Queda de'} </span>{pct(Math.abs(change))}</span> vs. anterior ({fmt(previous)})</span>;
}

function KpiCard({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'warning' | 'danger' }) {
  return (
    <Card className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-2xl sm:text-3xl font-semibold mt-1 tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</p>
      {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
    </Card>
  );
}

function Skeleton() {
  return (
    <div role="status" aria-label="Carregando indicadores" className="space-y-3 animate-pulse">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 8 }, (_, i) => <div key={i} className="h-24 rounded-2xl bg-surface-2" />)}</div>
      <div className="h-64 rounded-2xl bg-surface-2" />
      <div className="h-48 rounded-2xl bg-surface-2" />
    </div>
  );
}

/** Linhas de recebidas/entregues e área do saldo pendente. Setas do teclado percorrem os intervalos. */
function SeriesChart({ series, gran }: { series: any[]; gran: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [i, setI] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const on = () => setW(Math.max(260, el.clientWidth));
    on();
    const RO = (window as any).ResizeObserver;
    if (RO) { const ro = new RO(on); ro.observe(el); return () => ro.disconnect(); }
    window.addEventListener('resize', on); return () => window.removeEventListener('resize', on);
  }, []);
  const H = 220, L = 34, R = 8, T = 10, B = 24;
  const max = Math.max(1, ...series.map((s) => Math.max(s.received, s.delivered, s.balance)));
  const step = Math.pow(10, Math.floor(Math.log10(max))); const top = Math.ceil(max / step) * step;
  const x = (k: number) => L + (series.length === 1 ? (w - L - R) / 2 : (k * (w - L - R)) / (series.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const path = (key: string) => series.map((s, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(s[key]).toFixed(1)}`).join('');
  const area = `${path('balance')}L${x(series.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const every = Math.ceil(series.length / Math.max(2, Math.floor((w - L) / 56)));
  const cur = i == null ? null : series[i];
  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.round(((e.clientX - r.left - L) / Math.max(1, w - L - R)) * (series.length - 1));
    setI(Math.min(series.length - 1, Math.max(0, k)));
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setI((v) => Math.min(series.length - 1, Math.max(0, (v ?? -1) + (e.key === 'ArrowRight' ? 1 : -1)))); }
    if (e.key === 'Home') { e.preventDefault(); setI(0); }
    if (e.key === 'End') { e.preventDefault(); setI(series.length - 1); }
    if (e.key === 'Escape') setI(null);
  };
  const tip = cur ? `${bucketLabel(cur, gran)}: ${num(cur.received)} recebidas, ${num(cur.delivered)} entregues, saldo pendente ${num(cur.balance)}` : '';
  return (
    <div ref={box} className="relative overflow-hidden">
      <div tabIndex={0} role="group" aria-roledescription="gráfico" onKeyDown={key} onBlur={() => setI(null)} onFocus={() => setI((v) => v ?? series.length - 1)}
        aria-label={`Série ${GRAN[gran]} com ${series.length} intervalos. Use as setas para percorrer.`} className="rounded-xl focus:outline-none focus:ring-2 focus:ring-accent">
        <svg width={w} height={H} onMouseMove={pick} onMouseLeave={() => setI(null)} aria-hidden className="block">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}><line x1={L} x2={w - R} y1={y(top * f)} y2={y(top * f)} stroke="var(--c-border)" strokeDasharray={f ? '3 3' : undefined} />
              <text x={L - 4} y={y(top * f) + 3} textAnchor="end" fontSize="10" fill="var(--c-muted)">{num(Math.round(top * f))}</text></g>
          ))}
          <path d={area} fill="var(--c-muted)" opacity="0.15" />
          <path d={path('balance')} fill="none" stroke="var(--c-muted)" strokeWidth="1.5" strokeDasharray="4 3" />
          <path d={path('received')} fill="none" stroke="var(--c-secondary)" strokeWidth="2.5" strokeLinejoin="round" />
          <path d={path('delivered')} fill="none" stroke="var(--c-accent)" strokeWidth="2.5" strokeLinejoin="round" />
          {series.map((s, k) => k % every === 0 && <text key={s.start} x={x(k)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--c-muted)">{bucketLabel(s, gran)}</text>)}
          {cur && <g>
            <line x1={x(i!)} x2={x(i!)} y1={T} y2={y(0)} stroke="var(--c-text)" opacity="0.3" />
            <circle cx={x(i!)} cy={y(cur.received)} r="4" fill="var(--c-secondary)" />
            <circle cx={x(i!)} cy={y(cur.delivered)} r="4" fill="var(--c-accent)" />
          </g>}
        </svg>
      </div>
      {cur && <div className="pointer-events-none absolute top-0 rounded-lg border border-line bg-surface px-2 py-1 text-xs shadow-sm"
        style={{ left: Math.min(Math.max(0, x(i!) - 80), w - 170), width: 170 }}>
        <p className="font-semibold">{bucketLabel(cur, gran)}</p>
        <p>Recebidas: <span className="tabular-nums">{num(cur.received)}</span></p>
        <p>Entregues: <span className="tabular-nums">{num(cur.delivered)}</span></p>
        <p>Saldo pendente: <span className="tabular-nums">{num(cur.balance)}</span></p>
      </div>}
      <p className="sr-only" aria-live="polite">{tip}</p>
    </div>
  );
}

interface Saved { preset: Preset; from: string; to: string; filters: Filters }
const SIZES = [[5, 'Top 5'], [10, 'Top 10'], [20, 'Top 20'], [0, 'Todas']] as const;
const PAGE = 20;

export function Analysis() {
  const t = useTenant();
  const tz = t.tenant.timezone;
  // Seleção por condomínio (chave com o id): nunca reaproveita filtros de outro condomínio.
  const storeKey = `pp_painel_analise:${t.tenant.id}`;
  const initial = useMemo<Saved>(() => {
    const today = todayIn(tz);
    try {
      const s = JSON.parse(sessionStorage.getItem(storeKey) || 'null') as Saved | null;
      if (s && PRESETS.some(([p]) => p === s.preset)) {
        const r = s.preset === 'custom' && !rangeError(s.from, s.to) ? { from: s.from, to: s.to } : presetRange(s.preset === 'custom' ? '30' : s.preset, today);
        return { preset: s.preset, ...r, filters: cleanFilters(s.filters || {}) };
      }
    } catch { /* sem storage */ }
    return { preset: '30', ...presetRange('30', today), filters: {} };
  }, [storeKey, tz]);
  const [preset, setPreset] = useState<Preset>(initial.preset);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number>(10);
  const [page, setPage] = useState(0);
  const [rank, setRank] = useState<any>(null);
  const [rankError, setRankError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const invalid = rangeError(from, to);
  const f = useMemo(() => cleanFilters(filters), [filters]);
  const fKey = JSON.stringify(f);

  useEffect(() => {
    try { sessionStorage.setItem(storeKey, JSON.stringify({ preset, from, to, filters: f })); } catch { /* sem storage */ }
  }, [storeKey, preset, from, to, fKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') { const r = presetRange(p, todayIn(tz)); setFrom(r.from); setTo(r.to); }
  };
  const gen = useRef(0);
  const load = useCallback(() => {
    if (invalid) return;
    const g = ++gen.current;
    setD(null); setError(null);
    rpc('dashboard_executive', { p_tenant: t.tenant.id, p_from: from, p_to: to, p_filters: f })
      .then((x) => { if (g === gen.current) setD(x); }).catch((e) => { if (g === gen.current) setError(e.message); });
  }, [t.tenant.id, from, to, fKey, invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [from, to, fKey, size]);

  const rankGen = useRef(0);
  const loadRank = useCallback(() => {
    if (invalid) return;
    const g = ++rankGen.current;
    setRank(null); setRankError(null);
    rpc('dashboard_unit_ranking', { p_tenant: t.tenant.id, p_from: from, p_to: to, p_filters: f, p_limit: size || PAGE, p_offset: size ? 0 : page * PAGE })
      .then((x) => { if (g === rankGen.current) setRank(x); }).catch((e) => { if (g === rankGen.current) setRankError(e.message); });
  }, [t.tenant.id, from, to, fKey, size, page, invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadRank(); }, [loadRank]);

  const heat = useMemo(() => {
    const m = new Map<string, number>(); let max = 0;
    for (const h of d?.heatmap || []) { m.set(`${h.dow}-${h.hour}`, h.n); max = Math.max(max, h.n); }
    return { m, max };
  }, [d]);
  const tips = useMemo(() => (d ? insights(d) : []), [d]);
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((x) => ({ ...x, [k]: e.target.value }));
  const anyFilter = Object.keys(f).length > 0;
  const statuses: string[] = d?.options.statuses || [];
  const units: any[] = (d?.options.units || []).filter((u: any) => !f.block || u.block === f.block);

  /** Ranking exportado: o Top escolhido, ou todas as unidades (páginas de 200). */
  const rankingForExport = async () => {
    const args = { p_tenant: t.tenant.id, p_from: from, p_to: to, p_filters: f };
    if (size) return (await rpc('dashboard_unit_ranking', { ...args, p_limit: size, p_offset: 0 })).items;
    const all: any[] = [];
    for (let off = 0; off < 5000; off += 200) {
      const r = await rpc('dashboard_unit_ranking', { ...args, p_limit: 200, p_offset: off });
      all.push(...r.items); if (all.length >= r.total || !r.items.length) break;
    }
    return all;
  };
  const doExport = async (kind: 'csv' | 'xlsx' | 'pdf') => {
    if (!d) return;
    setExporting(kind);
    try {
      const tables = exportTables(d, await rankingForExport(), t.tenant.name);
      const name = exportName(t.tenant.slug, d.from, d.to, kind);
      if (kind === 'csv') download(name, exportCsv(tables));
      if (kind === 'xlsx') download(name, exportXlsx(tables), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (kind === 'pdf') {
        const { dashboardPdf } = await import('../../lib/dashboard-pdf');
        download(name, await dashboardPdf(`Painel do síndico — ${t.tenant.name}`, [`Período: ${periodLabel(d.from, d.to)} (anterior: ${periodLabel(d.previous.from, d.previous.to)})`,
          `Fuso ${d.timezone}. Gerado em ${dateTime(new Date().toISOString(), tz)}.`], tables), 'application/pdf');
      }
    } catch (e: any) { toast.error(e.message); } finally { setExporting(null); }
  };

  const pages = rank && !size ? Math.max(1, Math.ceil(rank.total / PAGE)) : 1;

  return (
    <div className="space-y-4">
      <Card className="space-y-3" data-tour="painel-filtros">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <Field label="Período">
            <Select value={preset} onChange={(e) => choose(e.target.value as Preset)}>
              {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          {preset === 'custom' ? <>
            <Field label="De"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Até"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          </> : <p className="text-sm text-muted sm:col-span-1 lg:col-span-2 self-center">{periodLabel(from, to)}</p>}
          <Field label="Bloco">
            <Select value={f.block || ''} onChange={(e) => setFilters((x) => ({ ...x, block: e.target.value, unit: '' }))} disabled={!d?.options.blocks.length}>
              <option value="">Todos</option>{(d?.options.blocks || []).map((b: string) => <option key={b} value={b}>{b}</option>)}
            </Select>
          </Field>
          <Field label="Unidade">
            <Select value={f.unit || ''} onChange={set('unit')}>
              <option value="">Todas</option>{units.map((u) => <option key={u.id} value={u.id}>{unitLabel(u.block, u.label)}</option>)}
            </Select>
          </Field>
          <Field label="Situação">
            <Select value={f.status || ''} onChange={set('status')}>
              <option value="">Todas</option>
              {statuses.some((s) => s === 'RECEBIDA' || s === 'ARMAZENADA') && <option value="PENDENTES">Aguardando retirada</option>}
              {statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}
            </Select>
          </Field>
          <Field label="Transportadora">
            <Select value={f.carrier || ''} onChange={set('carrier')}>
              <option value="">Todas</option>{(d?.options.carriers || []).map((c: string) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {anyFilter && <Button variant="ghost" onClick={() => setFilters({})}><RotateCcw className="w-4 h-4" aria-hidden /> Limpar filtros</Button>}
          <span className="flex-1" />
          <Button variant="secondary" onClick={() => doExport('csv')} loading={exporting === 'csv'} disabled={!d || !!exporting}><Download className="w-4 h-4" aria-hidden /> CSV</Button>
          <Button variant="secondary" onClick={() => doExport('xlsx')} loading={exporting === 'xlsx'} disabled={!d || !!exporting}><FileSpreadsheet className="w-4 h-4" aria-hidden /> Excel</Button>
          <Button variant="secondary" onClick={() => doExport('pdf')} loading={exporting === 'pdf'} disabled={!d || !!exporting}><FileText className="w-4 h-4" aria-hidden /> PDF</Button>
        </div>
        {invalid && <Alert tone="warning">{invalid}</Alert>}
      </Card>

      {invalid ? null : error ? (
        <Alert tone="danger">{error} <button className="underline min-h-10" onClick={load}>Tentar novamente</button></Alert>
      ) : !d ? <Skeleton /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard label="Recebidas no período" value={num(d.received.value)} hint={<Change {...d.received} />} />
            <KpiCard label="Entregues no período" value={num(d.delivered.value)} hint={<Change {...d.delivered} />} />
            <KpiCard label="Taxa de retirada" value={pct(d.cohort.rate)} hint={d.cohort.received ? `${num(d.cohort.picked)} de ${num(d.cohort.received)} recebidas no período já retiradas` : 'Sem recebidas no período'} />
            <KpiCard label="Aguardando retirada agora" value={num(d.pending_now)} hint="independe do período" />
            <KpiCard label={`Atrasadas (> ${d.overdue_hours} h)`} value={num(d.overdue_now)} tone={d.overdue_now ? 'warning' : undefined} hint="aguardando agora" />
            <KpiCard label="Tempo médio até retirada" value={hours(d.pickup_time.avg_h)}
              hint={d.pickup_time.n ? <><span>mediana {hours(d.pickup_time.median_h)} · </span><Change value={d.pickup_time.avg_h} previous={d.pickup_time.avg_h_previous} change={d.pickup_time.change} invert fmt={hours} /></> : 'Sem entregas no período'} />
            <KpiCard label="Unidades movimentadas" value={num(d.units_moved.value)} hint={<Change {...d.units_moved} />} />
            <KpiCard label="Entregues em até 48 h" value={pct(d.efficiency.within_48h)} hint={d.efficiency.within_24h == null ? 'Sem entregas no período' : `${pct(d.efficiency.within_24h)} em até 24 h`} />
          </div>

          {tips.length > 0 && <Card>
            <p className="font-semibold flex items-center gap-2"><Lightbulb className="w-4 h-4 text-secondary" aria-hidden /> Inteligência do condomínio</p>
            <p className="text-xs text-muted mb-2">Constatações calculadas dos números do período; não são previsões.</p>
            <ul className="grid sm:grid-cols-2 gap-2">
              {tips.map((i) => <li key={i.id} className={`rounded-xl border p-3 text-sm ${i.tone === 'warning' ? 'border-warning/30 bg-warning-bg' : 'border-line bg-surface-2'}`}>
                <p>{i.text}</p><p className="text-xs text-muted mt-1 tabular-nums">Base: {i.basis}</p></li>)}
            </ul>
          </Card>}

          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold">Recebidas, entregues e saldo pendente {GRAN[d.granularity]}</p>
              <p className="text-xs text-muted">
                <span className="inline-block w-3 h-0.5 bg-secondary align-middle mr-1" />Recebidas
                <span className="inline-block w-3 h-0.5 bg-accent align-middle ml-3 mr-1" />Entregues
                <span className="inline-block w-3 h-2 bg-muted/30 align-middle ml-3 mr-1" />Saldo no fim do intervalo
              </p>
            </div>
            {d.series.every((s: any) => !s.received && !s.delivered && !s.balance) ? <Empty title="Sem movimentação no período" /> : <div className="mt-3"><SeriesChart series={d.series} gran={d.granularity} /></div>}
            <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted min-h-10 inline-flex items-center">Ver tabela</summary>
              <div className="max-h-60 overflow-y-auto"><table className="w-full mt-2"><thead className="text-left text-muted"><tr><th className="font-medium">Intervalo</th><th className="font-medium">Recebidas</th><th className="font-medium">Entregues</th><th className="font-medium">Saldo</th></tr></thead>
                <tbody>{d.series.map((s: any) => <tr key={s.start}><td>{bucketLabel(s, d.granularity)}</td><td className="tabular-nums">{s.received}</td><td className="tabular-nums">{s.delivered}</td><td className="tabular-nums">{s.balance}</td></tr>)}</tbody></table></div>
            </details>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <p className="font-semibold">Ranking de unidades</p>
              <div role="radiogroup" aria-label="Quantidade" className="inline-flex rounded-xl border border-line p-1">
                {SIZES.map(([v, l]) => <button key={v} role="radio" aria-checked={size === v} onClick={() => setSize(v)} className={`px-2 sm:px-3 min-h-10 rounded-lg text-sm ${size === v ? 'bg-surface-2 font-semibold' : ''}`}>{l}</button>)}
              </div>
            </div>
            {rankError ? <Alert tone="danger">{rankError} <button className="underline min-h-10" onClick={loadRank}>Tentar novamente</button></Alert>
              : !rank ? <div className="h-40 rounded-xl bg-surface-2 animate-pulse" role="status" aria-label="Carregando ranking" />
                : rank.items.length === 0 ? <Empty title="Nenhuma unidade movimentada no período" /> : (
                  <table className="w-full text-sm table-fixed">
                    <thead className="text-left text-muted text-xs"><tr>
                      <th className="font-medium py-2 w-8">#</th><th className="font-medium">Unidade</th>
                      <th className="font-medium text-right">Receb.</th><th className="font-medium text-right">Entr.</th><th className="font-medium text-right">Pend.</th>
                      <th className="font-medium text-right hidden sm:table-cell">% total</th><th className="font-medium text-right hidden md:table-cell">Variação</th>
                      <th className="font-medium text-right hidden md:table-cell">Tempo médio</th>
                    </tr></thead>
                    <tbody className="divide-y divide-line">
                      {rank.items.map((u: any, k: number) => (
                        <tr key={u.unit_id}>
                          <td className="py-2 text-muted tabular-nums">{rank.offset + k + 1}</td>
                          <td className="truncate" title={unitLabel(u.block, u.unit)}>{unitLabel(u.block, u.unit)}</td>
                          <td className="text-right tabular-nums">{num(u.received)}</td><td className="text-right tabular-nums">{num(u.delivered)}</td>
                          <td className={`text-right tabular-nums ${u.pending ? 'font-semibold' : ''}`}>{num(u.pending)}</td>
                          <td className="text-right tabular-nums hidden sm:table-cell">{pct(u.share, 1)}</td>
                          <td className="text-right tabular-nums hidden md:table-cell">{u.change == null ? '—' : `${u.change > 0 ? '+' : ''}${pct(u.change)}`}</td>
                          <td className="text-right tabular-nums hidden md:table-cell">{hours(u.avg_pickup_h)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            {rank && <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs text-muted">
              <span>{num(rank.total)} unidade(s) com movimento ou pendência · % sobre {num(rank.received_total)} recebidas</span>
              {!size && pages > 1 && <span className="inline-flex items-center gap-1">
                <Button variant="ghost" aria-label="Página anterior" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft className="w-4 h-4" aria-hidden /></Button>
                <span className="tabular-nums">{page + 1} de {pages}</span>
                <Button variant="ghost" aria-label="Próxima página" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight className="w-4 h-4" aria-hidden /></Button>
              </span>}
            </div>}
            <p className="text-xs text-muted mt-2">Ranking por destinatário: indisponível. {d.recipients.reason}</p>
          </Card>

          {/* minmax(0,1fr): sem isso o conteúdo mínimo dos cards estoura a tela em 320 px. */}
          <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-2 gap-3">
            <Card className="min-w-0">
              <p className="font-semibold mb-2">Aguardando agora, por tempo</p>
              <ul className="grid grid-cols-2 min-[360px]:grid-cols-4 gap-2 text-center mb-3">
                {([['lt24', 'Até 24 h'], ['h24_48', '24–48 h'], ['h48_72', '48–72 h'], ['gt72', '> 72 h']] as const).map(([k, l]) => (
                  <li key={k} className={`rounded-xl p-2 ${k === 'gt72' && d.aging_now[k] ? 'bg-warning-bg text-warning' : 'bg-surface-2'}`}>
                    <p className="text-xl font-semibold tabular-nums">{num(d.aging_now[k])}</p><p className="text-xs">{l}</p></li>
                ))}
              </ul>
              {d.oldest_waiting.length === 0 ? <p className="text-sm text-muted">Nenhuma encomenda aguardando.</p> : <>
                <p className="text-xs text-muted mb-1">Mais antigas aguardando (até 20)</p>
                <ul className="divide-y divide-line text-sm max-h-64 overflow-y-auto">
                  {d.oldest_waiting.map((o: any, k: number) => (
                    <li key={k} className="py-1.5 flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{unitLabel(o.block, o.unit)} <span className="text-muted">· {dateTime(o.received_at, tz)}</span></span>
                      <span className="shrink-0 flex items-center gap-2"><span className="tabular-nums">{o.hours < 48 ? `${Math.round(o.hours)} h` : `${Math.floor(o.hours / 24)} d`}</span>
                        <Badge tone={o.hours > d.overdue_hours ? 'warning' : 'neutral'}>{STATUS_LABEL[o.status]}</Badge></span>
                    </li>
                  ))}
                </ul>
              </>}
            </Card>
            <Card>
              <p className="font-semibold mb-2">Eficiência</p>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-muted">Recebimento → aviso (mediana)</dt><dd className="text-xl font-semibold tabular-nums">{hours(d.efficiency.receipt_to_notice.median_h)}</dd>
                  <dd className="text-xs text-muted">{d.efficiency.receipt_to_notice.n ? `${num(d.efficiency.receipt_to_notice.n)} com aviso aceito` : 'Sem aviso registrado'}{d.efficiency.receipt_to_notice.without_notice ? ` · ${num(d.efficiency.receipt_to_notice.without_notice)} sem aviso` : ''}</dd></div>
                <div><dt className="text-xs text-muted">Aviso → retirada (mediana)</dt><dd className="text-xl font-semibold tabular-nums">{hours(d.efficiency.notice_to_pickup.median_h)}</dd>
                  <dd className="text-xs text-muted">{d.efficiency.notice_to_pickup.n ? `${num(d.efficiency.notice_to_pickup.n)} entregas com aviso` : 'Sem dado'}</dd></div>
                <div><dt className="text-xs text-muted">Entregues em até 24 h</dt><dd className="text-xl font-semibold tabular-nums">{pct(d.efficiency.within_24h)}</dd></div>
                <div><dt className="text-xs text-muted">Entregues em até 48 h</dt><dd className="text-xl font-semibold tabular-nums">{pct(d.efficiency.within_48h)}</dd>
                  <dd className="text-xs text-muted">anterior: {pct(d.efficiency.within_48h_previous)}</dd></div>
              </dl>
              <p className="text-xs text-muted mt-3">Aviso = primeiro aviso aceito pelo provedor (não confirma leitura). Adesão: {d.adoption.units_with_resident} de {d.adoption.units_active} unidades com morador aprovado.</p>
            </Card>
          </div>

          <Card>
            <p className="font-semibold">Quando as encomendas chegam</p>
            {!heat.max ? <p className="text-sm text-muted">Sem recebidas no período.</p> : <>
              <p className="text-sm text-muted mb-3">Cor mais forte = mais recebidas no dia da semana e hora (fuso do condomínio).</p>
              <table className="w-full table-fixed text-[10px]" aria-label="Recebidas por dia da semana e hora">
                <thead><tr><th className="w-8" />{Array.from({ length: 24 }, (_, h) => <th key={h} className="font-normal text-muted">{h % 6 === 0 ? h : ''}</th>)}</tr></thead>
                <tbody>{DOW.map((w, i) => <tr key={w}><th className="font-normal text-muted pr-1 text-left">{w}</th>
                  {Array.from({ length: 24 }, (_, h) => { const v = heat.m.get(`${i + 1}-${h}`) || 0; return <td key={h} title={`${w} ${h}h: ${v}`} className="h-4 sm:h-5 rounded-sm border border-surface" style={{ background: v ? `color-mix(in srgb, var(--c-secondary) ${20 + 80 * v / heat.max}%, transparent)` : 'var(--c-surface-2, #eee)' }}><span className="sr-only">{w} {h}h: {v}</span></td>; })}</tr>)}</tbody>
              </table>
            </>}
          </Card>

          <div className="grid lg:grid-cols-3 gap-3">
            <Card>
              <p className="font-semibold mb-2">Transportadoras</p>
              {d.carriers.length === 0 ? <p className="text-sm text-muted">Sem recebidas no período.</p> : (
                <ul className="space-y-1 text-sm">{d.carriers.map((c: any) => <li key={c.carrier} className="flex justify-between gap-2"><span className="truncate">{c.carrier}</span><span className="tabular-nums shrink-0">{num(c.n)} · {pct(c.n / d.received.value)}</span></li>)}</ul>
              )}
            </Card>
            <Card>
              <p className="font-semibold mb-2">Exceções no período</p>
              {d.exceptions.length === 0 ? <p className="text-sm text-muted">Nenhuma devolução, cancelamento ou extravio registrado.</p>
                : <ul className="space-y-1 text-sm">{d.exceptions.map((e: any) => <li key={e.status} className="flex justify-between"><span>{STATUS_LABEL[e.status]}</span><span className="tabular-nums">{num(e.n)}</span></li>)}</ul>}
            </Card>
            <Card>
              <p className="font-semibold mb-2">Comunicações por canal</p>
              {d.channels.length === 0 ? <p className="text-sm text-muted">Nenhum aviso no período.</p> : (
                <table className="w-full text-sm"><tbody>{d.channels.slice().sort((a: any, b: any) => a.channel.localeCompare(b.channel)).map((c: any) => (
                  <tr key={c.channel + c.state}><td>{CH[c.channel] || c.channel}</td><td className="text-muted">{STATE[c.state] || c.state}</td><td className="text-right tabular-nums">{num(c.n)}</td></tr>))}</tbody></table>
              )}
              <p className="text-xs text-muted mt-2">Todo o condomínio (não usa os filtros de encomenda). “Aceito pelo provedor” não significa que o morador leu.</p>
            </Card>
          </div>
          <p className="text-xs text-muted">Calculado no servidor, no fuso {d.timezone}, em {dateTime(d.as_of, tz)}. Período anterior: {periodLabel(d.previous.from, d.previous.to)}. Saldo pendente = recebidas até o fim do intervalo menos as retiradas ou encerradas por exceção até o fim.</p>
        </>
      )}
    </div>
  );
}
