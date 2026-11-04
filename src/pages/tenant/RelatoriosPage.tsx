import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, FileText, X } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { onLink, query } from '../../lib/router';
import { dateTime, download, STATUS_LABEL, toCsv, unitName } from '../../lib/format';
import { RELATIONS, relationLabel } from '../../lib/resident-signup';
import { parseReportQuery } from '../../lib/report-query';
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Spinner, toast } from '../../components/ui';

/**
 * Relatórios da administração: encomendas e moradores/unidades.
 * Filtros aplicados NO SERVIDOR (report_packages / report_residents); lista, totais e exportações
 * usam exatamente o mesmo recorte. Exportação busca todas as páginas do recorte (cursor).
 */
const ymd = (tz: string, delta = 0) => new Date(Date.now() + delta * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
const n = (v: unknown) => Number(v || 0).toLocaleString('pt-BR');
const RES_STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  active: ['Ativo', 'success'], pending: ['Pendente', 'warning'], rejected: ['Recusado', 'danger'], revoked: ['Inativo', 'neutral'],
};
const VIA: Record<string, string> = { portaria: 'Portaria', totem: 'Totem' };

type Opt = { blocks: string[]; units: { id: string; block: string | null; label: string }[]; carriers: string[]; operators: { id: string; name: string; role: string }[] };
type PkgFilters = Partial<Record<'block' | 'unit' | 'carrier' | 'status' | 'received_from' | 'received_to' | 'picked_from' | 'picked_to' | 'operator' | 'recipient' | 'search' | 'registered_via', string>>;

/** Remove vazios (o servidor recusa chaves desconhecidas, aceita vazias, mas a URL fica limpa). */
const clean = <T extends Record<string, string | undefined>>(f: T) => Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as T;

export function RelatoriosPage() {
  const t = useTenant();
  const [kind, setKind] = useState<'encomendas' | 'moradores'>(query('tipo') === 'moradores' ? 'moradores' : 'encomendas');
  const [opt, setOpt] = useState<Opt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { rpc<Opt>('report_filter_options', { p_tenant: t.tenant.id }).then(setOpt).catch((e) => setError(e.message)); }, [t.tenant.id]);
  if (error) return <Alert tone="danger">{error}</Alert>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-semibold">Relatórios</h1>
        <div role="tablist" aria-label="Tipo de relatório" className="inline-flex rounded-xl border border-line p-1">
          {([['encomendas', 'Encomendas'], ['moradores', 'Moradores e unidades']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
              className={`min-h-10 px-4 rounded-lg text-sm font-medium ${kind === k ? 'bg-primary text-primary-fg' : 'text-muted hover:text-text'}`}>{l}</button>
          ))}
        </div>
      </div>
      {!opt ? <Spinner /> : kind === 'encomendas' ? <PackagesReport opt={opt} /> : <ResidentsReport opt={opt} />}
    </div>
  );
}

function PackagesReport({ opt }: { opt: Opt }) {
  const t = useTenant();
  const tz = t.tenant.timezone;
  const oldOnly = query('antigas') === '1';
  const [f, setF] = useState<PkgFilters>(() => ({
    received_from: oldOnly ? '' : ymd(tz, -29), received_to: oldOnly ? ymd(tz, -3) : ymd(tz), status: query('status') || (oldOnly ? 'PENDENTES' : ''),
  }));
  const [advanced, setAdvanced] = useState(false);
  const [ask, setAsk] = useState('');
  const [asked, setAsked] = useState<{ understood: string[]; ignored: string[]; ranking: number | null } | null>(null);
  const rankRef = React.useRef<HTMLDivElement>(null);
  const runAsk = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ask.trim()) return;
    const r = parseReportQuery(ask, { today: ymd(tz), blocks: opt.blocks, units: opt.units, carriers: opt.carriers });
    setF(r.filters); setAsked(r);
    if (r.ranking) setTimeout(() => rankRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 600);
  };
  const [rows, setRows] = useState<any[] | null>(null);
  const [sum, setSum] = useState<any>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filters = useMemo(() => clean(f), [f]);
  const key = JSON.stringify(filters);
  const units = opt.units.filter((u) => !f.block || (u.block || '').toUpperCase() === f.block.toUpperCase());

  const load = useCallback(async () => {
    setRows(null); setSum(null); setError(null);
    try {
      const [r, s] = await Promise.all([
        rpc<any[]>('report_packages', { p_tenant: t.tenant.id, p_filters: filters, p_limit: 100 }),
        rpc<any>('report_packages_summary', { p_tenant: t.tenant.id, p_filters: filters }),
      ]);
      setRows(r); setSum(s); setMore(r.length === 100);
    } catch (e: any) { setError(e.message); }
  }, [t.tenant.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const id = setTimeout(load, 250); return () => clearTimeout(id); }, [load]);

  const loadMore = async () => {
    const last = rows![rows!.length - 1];
    const r = await rpc<any[]>('report_packages', { p_tenant: t.tenant.id, p_filters: filters, p_limit: 100, p_cursor_at: last.received_at, p_cursor_id: last.id });
    setRows([...rows!, ...r]); setMore(r.length === 100);
  };
  const fetchAll = async () => {
    const out: any[] = [];
    let cur: any = null;
    for (;;) {
      const page = await rpc<any[]>('report_packages', { p_tenant: t.tenant.id, p_filters: filters, p_limit: 1000, p_cursor_at: cur?.received_at || null, p_cursor_id: cur?.id || null });
      out.push(...page);
      if (page.length < 1000) return out;
      cur = page[page.length - 1];
    }
  };
  const COLS: [string, string][] = [['unit', 'Unidade'], ['carrier', 'Transportadora'], ['tracking_code', 'Rastreio'], ['protocol', 'Protocolo'], ['recipient_name', 'Destinatário'],
    ['status_label', 'Situação'], ['received', 'Recebida em'], ['received_by_name', 'Recebida por'], ['picked', 'Retirada em'], ['picked_up_by_name', 'Retirada por'],
    ['delivered_by_name', 'Entregue por'], ['hours_waiting', 'Horas até a retirada'], ['via', 'Registro'], ['resolution_reason', 'Motivo da exceção']];
  const shape = (p: any) => ({ ...p, unit: unitName(p.unit_block, p.unit_label), status_label: STATUS_LABEL[p.status] || p.status, received: dateTime(p.received_at, tz),
    picked: dateTime(p.picked_up_at, tz), via: VIA[p.registered_via] || p.registered_via });
  const base = `encomendas-${t.tenant.slug}-${f.received_from || 'inicio'}-a-${f.received_to || 'hoje'}`;
  const describe = () => [
    f.received_from || f.received_to ? `Recebidas de ${f.received_from || 'início'} a ${f.received_to || 'hoje'}` : 'Todo o período',
    f.block && `Bloco ${f.block}`, f.unit && (() => { const u = opt.units.find((x) => x.id === f.unit); return u ? unitName(u.block, u.label) : null; })(),
    f.status && (f.status === 'PENDENTES' ? 'Pendentes' : STATUS_LABEL[f.status]), f.carrier && f.carrier,
    f.operator && `Equipe: ${opt.operators.find((o) => o.id === f.operator)?.name}`, f.picked_from || f.picked_to ? `Retiradas de ${f.picked_from || 'início'} a ${f.picked_to || 'hoje'}` : null,
    f.recipient && `Destinatário: ${f.recipient}`, f.search && `Busca: ${f.search}`,
  ].filter(Boolean) as string[];
  const exp = async (type: 'csv' | 'xlsx' | 'pdf') => {
    setBusy(type);
    try {
      const all = (await fetchAll()).map(shape);
      if (type === 'csv') download(`${base}.csv`, toCsv(all, COLS));
      else if (type === 'xlsx') {
        const { xlsx } = await import('../../lib/xlsx');
        const s = sum || {};
        download(`${base}.xlsx`, xlsx([
          { name: 'Encomendas', rows: [COLS.map(([, h]) => h), ...all.map((r) => COLS.map(([k]) => r[k] ?? ''))] },
          { name: 'Resumo', rows: [['Indicador', 'Valor'], ['Total', s.total], ['Aguardando retirada', s.pending], ['Retiradas', s.picked], ['Exceções', s.exceptions], ['Tempo médio até retirada (h)', s.avg_pickup_h ?? ''], [], ['Filtros', describe().join(' · ')]] },
          { name: 'Por transportadora', rows: [['Transportadora', 'Encomendas'], ...(s.by_carrier || []).map((x: any) => [x.carrier, x.n])] },
          { name: 'Top unidades', rows: [['Unidade', 'Encomendas'], ...(s.top_units || []).map((x: any) => [x.unit, x.n])] },
        ]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      } else {
        const { dashboardPdf } = await import('../../lib/dashboard-pdf');
        const s = sum || {};
        const bytes = await dashboardPdf(`Relatório de encomendas — ${t.branding?.display_name || t.tenant.name}`,
          [...describe(), `Gerado em ${dateTime(new Date().toISOString(), tz)}`], [
            { name: 'Indicadores', rows: [['Indicador', 'Valor'], ['Total', s.total], ['Aguardando retirada', s.pending], ['Retiradas', s.picked], ['Exceções', s.exceptions], ['Tempo médio até retirada (h)', s.avg_pickup_h ?? '—']] },
            { name: 'Por transportadora', rows: [['Transportadora', 'Encomendas'], ...(s.by_carrier || []).map((x: any) => [x.carrier, x.n])] },
            { name: 'Unidades que mais receberam', rows: [['Unidade', 'Encomendas'], ...(s.top_units || []).map((x: any) => [x.unit, x.n])] },
            { name: `Encomendas (${all.length})`, rows: [['Unidade', 'Transportadora', 'Situação', 'Recebida', 'Retirada por'], ...all.slice(0, 2000).map((r) => [r.unit, r.carrier, r.status_label, r.received, r.picked_up_by_name || '—'])] },
          ]);
        download(`${base}.pdf`, bytes, 'application/pdf');
      }
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  const set = (k: keyof PkgFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value, ...(k === 'block' ? { unit: '' } : {}) });
  const active = describe().length - 1 + (f.received_from || f.received_to ? 0 : 0);
  const presets: [string, () => void][] = [
    ['Últimos 30 dias', () => setF({ received_from: ymd(tz, -29), received_to: ymd(tz) })],
    ['Este ano', () => setF({ received_from: `${ymd(tz).slice(0, 4)}-01-01`, received_to: ymd(tz) })],
    ['Pendentes agora', () => setF({ status: 'PENDENTES' })],
    ['Paradas há +72 h', () => setF({ status: 'PENDENTES', received_to: ymd(tz, -3) })],
  ];

  return (
    <div className="space-y-4">
      {oldOnly && <Alert tone="info">Mostrando encomendas aguardando há mais de 72 h. <a className="underline" href={`/c/${t.tenant.slug}/relatorios`} onClick={onLink}>Limpar filtro</a></Alert>}
      <Card className="space-y-2">
        <form onSubmit={runAsk} className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[14rem]"><Field label="Pergunte ao relatório" hint='Ex.: "pendentes do apartamento 204 do bloco A", "ranking das 10 unidades que mais receberam no ano", "retiradas em março"'>
            <Input value={ask} maxLength={200} onChange={(e) => setAsk(e.target.value)} /></Field></div>
          <Button type="submit" disabled={!ask.trim()}>Buscar</Button>
        </form>
        {asked && <p className="text-xs text-muted" role="status">{asked.understood.length ? <>Entendi: <strong>{asked.understood.join(' · ')}</strong>. Os filtros abaixo foram preenchidos e podem ser ajustados.</> : 'Não identifiquei filtros nessa pergunta. Use os campos abaixo.'}
          {asked.ignored.length > 0 && <> Não usei: {asked.ignored.join(', ')}.</>}</p>}
      </Card>
      <Card className="space-y-3" data-tour="painel-exportar">
        <div className="flex flex-wrap gap-2">{presets.map(([l, fn]) => <Button key={l} variant="secondary" className="min-h-9 text-xs" onClick={fn}>{l}</Button>)}</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Recebidas de"><Input type="date" value={f.received_from || ''} max={f.received_to || undefined} onChange={set('received_from')} /></Field>
          <Field label="até"><Input type="date" value={f.received_to || ''} min={f.received_from || undefined} onChange={set('received_to')} /></Field>
          <Field label="Situação"><Select value={f.status || ''} onChange={set('status')}>
            <option value="">Todas</option><option value="PENDENTES">Pendentes (aguardando retirada)</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Transportadora / origem"><Select value={f.carrier || ''} onChange={set('carrier')}>
            <option value="">Todas</option>{opt.carriers.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          {opt.blocks.length > 0 && <Field label="Bloco"><Select value={f.block || ''} onChange={set('block')}>
            <option value="">Todos</option>{opt.blocks.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>}
          <Field label="Unidade"><Select value={f.unit || ''} onChange={set('unit')}>
            <option value="">Todas</option>{units.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label)}</option>)}</Select></Field>
          <Field label="Rastreio ou protocolo"><Input value={f.search || ''} maxLength={80} onChange={set('search')} placeholder="BR123…, PP-…" /></Field>
          <Field label="Destinatário"><Input value={f.recipient || ''} maxLength={80} onChange={set('recipient')} /></Field>
        </div>
        <button type="button" className="text-sm underline text-secondary" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Menos filtros' : 'Mais filtros (entrega, equipe, registro)'}</button>
        {advanced && <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Retiradas de"><Input type="date" value={f.picked_from || ''} onChange={set('picked_from')} /></Field>
          <Field label="até"><Input type="date" value={f.picked_to || ''} onChange={set('picked_to')} /></Field>
          <Field label="Porteiro / responsável"><Select value={f.operator || ''} onChange={set('operator')}>
            <option value="">Toda a equipe</option>{opt.operators.map((o) => <option key={o.id} value={o.id}>{o.name}{o.role === 'admin' ? ' (administração)' : ''}</option>)}</Select></Field>
          <Field label="Registrada pelo"><Select value={f.registered_via || ''} onChange={set('registered_via')}>
            <option value="">Qualquer</option><option value="portaria">Portaria</option><option value="totem">Totem</option></Select></Field>
        </div>}
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex flex-wrap gap-1 text-xs">{describe().map((d) => <Badge key={d} tone="neutral">{d}</Badge>)}
            {active > 0 && <button className="inline-flex items-center gap-1 underline text-muted" onClick={() => setF({})}><X className="w-3 h-3" aria-hidden /> Limpar filtros</button>}</div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => exp('csv')} loading={busy === 'csv'} disabled={!!busy || !sum?.total}><Download className="w-4 h-4" aria-hidden /> CSV</Button>
            <Button variant="secondary" onClick={() => exp('xlsx')} loading={busy === 'xlsx'} disabled={!!busy || !sum?.total}><FileSpreadsheet className="w-4 h-4" aria-hidden /> Excel</Button>
            <Button variant="secondary" onClick={() => exp('pdf')} loading={busy === 'pdf'} disabled={!!busy || !sum?.total}><FileText className="w-4 h-4" aria-hidden /> PDF</Button>
          </div>
        </div>
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      {sum && <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {([['Encomendas', sum.total], ['Aguardando retirada', sum.pending], ['Retiradas', sum.picked], ['Exceções', sum.exceptions], ['Tempo médio até retirada', sum.avg_pickup_h == null ? '—' : `${String(sum.avg_pickup_h).replace('.', ',')} h`]] as [string, any][]).map(([l, v]) => (
          <Card key={l}><p className="text-xs text-muted">{l}</p><p className="text-2xl font-semibold tabular-nums mt-1">{typeof v === 'number' ? n(v) : v}</p></Card>
        ))}
      </div>}
      {sum && sum.total > 0 && <div className="grid lg:grid-cols-2 gap-3">
        <Bars title="Por transportadora / origem" items={sum.by_carrier.map((x: any) => [x.carrier, x.n])} />
        <div ref={rankRef}><Bars title={`Unidades que mais receberam${asked?.ranking ? ` (top ${Math.min(asked.ranking, 10)})` : ''}`} items={sum.top_units.slice(0, asked?.ranking || 10).map((x: any) => [x.unit || '—', x.n])} /></div>
      </div>}
      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nenhuma encomenda com esses filtros" /> : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="text-left text-muted"><tr>{['Unidade', 'Transportadora', 'Rastreio / protocolo', 'Recebida', 'Situação', 'Retirada por', 'Equipe'].map((h) => <th key={h} className="py-2 pr-3 first:pl-4 sm:first:pl-0 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => (
                  <tr key={p.id} className="align-top">
                    <td className="py-2 pr-3 pl-4 sm:pl-0 whitespace-nowrap">{unitName(p.unit_block, p.unit_label)}</td>
                    <td className="pr-3">{p.carrier}</td>
                    <td className="pr-3 text-xs"><span className="font-mono">{p.tracking_code || '—'}</span>{p.protocol && <span className="block text-muted">{p.protocol}</span>}</td>
                    <td className="pr-3 whitespace-nowrap">{dateTime(p.received_at, tz)}</td>
                    <td className="pr-3">{STATUS_LABEL[p.status] || p.status}</td>
                    <td className="pr-3">{p.picked_up_by_name ? <>{p.picked_up_by_name}<span className="block text-xs text-muted">{dateTime(p.picked_up_at, tz)}</span></> : '—'}</td>
                    <td className="text-xs text-muted">{p.received_by_name}{p.delivered_by_name && p.delivered_by_name !== p.received_by_name ? ` → ${p.delivered_by_name}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && <p className="text-xs text-muted mt-2">Mostrando {n(rows.length)} de {n(sum?.total)}.</p>}
        {more && <Button variant="ghost" className="mt-2" onClick={loadMore}>Carregar mais</Button>}
      </Card>
    </div>
  );
}

/** Barras horizontais acessíveis (valor em texto; barra é decorativa). */
function Bars({ title, items }: { title: string; items: [string, number][] }) {
  const max = Math.max(1, ...items.map(([, v]) => v));
  return (
    <Card className="space-y-2">
      <p className="font-semibold text-sm">{title}</p>
      <ul className="space-y-1.5">{items.slice(0, 10).map(([l, v]) => (
        <li key={l} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-sm">
          <span className="truncate" title={l}>{l}</span>
          <span className="h-2.5 rounded-full bg-surface-2 overflow-hidden" aria-hidden><span className="block h-full bg-primary rounded-full" style={{ width: `${(v / max) * 100}%` }} /></span>
          <span className="tabular-nums text-muted">{n(v)}</span>
        </li>
      ))}</ul>
    </Card>
  );
}

function ResidentsReport({ opt }: { opt: Opt }) {
  const t = useTenant();
  const [f, setF] = useState<Partial<Record<'block' | 'unit' | 'status' | 'occupancy' | 'search' | 'relation', string>>>({});
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const filters = useMemo(() => clean(f), [f]);
  const key = JSON.stringify(filters);
  useEffect(() => {
    setRows(null); setError(null);
    const id = setTimeout(() => rpc<any[]>('report_residents', { p_tenant: t.tenant.id, p_filters: filters }).then(setRows).catch((e) => setError(e.message)), 250);
    return () => clearTimeout(id);
  }, [t.tenant.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const units = opt.units.filter((u) => !f.block || (u.block || '').toUpperCase() === f.block.toUpperCase());
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value, ...(k === 'block' ? { unit: '' } : {}) });
  const stats = useMemo(() => {
    if (!rows) return null;
    const unitsSet = new Map<string, boolean>();
    for (const r of rows) unitsSet.set(r.unit_id, (unitsSet.get(r.unit_id) || false) || r.status === 'active');
    return { units: unitsSet.size, occupied: [...unitsSet.values()].filter(Boolean).length,
      active: rows.filter((r) => r.status === 'active').length, pending: rows.filter((r) => r.status === 'pending').length };
  }, [rows]);
  const COLS: [string, string][] = [['unit', 'Unidade'], ['full_name', 'Morador'], ['relation_label', 'Perfil'], ['status_label', 'Situação'], ['email', 'E-mail'], ['phone', 'Celular'], ['since_fmt', 'Desde']];
  const shape = (r: any) => ({ ...r, unit: unitName(r.block, r.label), status_label: r.status ? RES_STATUS[r.status][0] : 'Sem morador', relation_label: relationLabel(r.relation) || '', since_fmt: r.since ? dateTime(r.since, t.tenant.timezone) : '' });
  const exp = async (type: 'csv' | 'xlsx' | 'pdf') => {
    setBusy(type);
    try {
      const all = rows!.map(shape);
      const base = `moradores-${t.tenant.slug}`;
      if (type === 'csv') download(`${base}.csv`, toCsv(all, COLS));
      else if (type === 'xlsx') {
        const { xlsx } = await import('../../lib/xlsx');
        download(`${base}.xlsx`, xlsx([{ name: 'Moradores', rows: [COLS.map(([, h]) => h), ...all.map((r) => COLS.map(([k]) => r[k] ?? ''))] }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      } else {
        const { dashboardPdf } = await import('../../lib/dashboard-pdf');
        download(`${base}.pdf`, await dashboardPdf(`Moradores e unidades — ${t.branding?.display_name || t.tenant.name}`,
          [`${n(stats?.units)} unidade(s) · ${n(stats?.occupied)} com morador ativo · ${n(stats?.active)} morador(es) ativo(s) · ${n(stats?.pending)} pendente(s)`, `Gerado em ${dateTime(new Date().toISOString(), t.tenant.timezone)}`],
          [{ name: 'Moradores', rows: [['Unidade', 'Morador', 'Situação', 'Celular'], ...all.map((r) => [r.unit, r.full_name || '—', r.status_label, r.phone || ''])] }]), 'application/pdf');
      }
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
          {opt.blocks.length > 0 && <Field label="Bloco"><Select value={f.block || ''} onChange={set('block')}><option value="">Todos</option>{opt.blocks.map((b) => <option key={b}>{b}</option>)}</Select></Field>}
          <Field label="Unidade"><Select value={f.unit || ''} onChange={set('unit')}><option value="">Todas</option>{units.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label)}</option>)}</Select></Field>
          <Field label="Situação do morador"><Select value={f.status || ''} onChange={set('status')}><option value="">Todas</option>{Object.entries(RES_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Perfil"><Select value={f.relation || ''} onChange={set('relation')}><option value="">Todos</option>{RELATIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Ocupação"><Select value={f.occupancy || ''} onChange={set('occupancy')}><option value="">Todas as unidades</option><option value="with">Com morador ativo</option><option value="without">Sem morador cadastrado</option></Select></Field>
          <Field label="Buscar"><Input value={f.search || ''} maxLength={80} onChange={set('search')} placeholder="Nome, e-mail, unidade" /></Field>
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="secondary" onClick={() => exp('csv')} loading={busy === 'csv'} disabled={!!busy || !rows?.length}><Download className="w-4 h-4" aria-hidden /> CSV</Button>
          <Button variant="secondary" onClick={() => exp('xlsx')} loading={busy === 'xlsx'} disabled={!!busy || !rows?.length}><FileSpreadsheet className="w-4 h-4" aria-hidden /> Excel</Button>
          <Button variant="secondary" onClick={() => exp('pdf')} loading={busy === 'pdf'} disabled={!!busy || !rows?.length}><FileText className="w-4 h-4" aria-hidden /> PDF</Button>
        </div>
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      {stats && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {([['Unidades no recorte', stats.units], ['Com morador ativo', stats.occupied], ['Moradores ativos', stats.active], ['Cadastros pendentes', stats.pending]] as [string, number][]).map(([l, v]) =>
          <Card key={l}><p className="text-xs text-muted">{l}</p><p className="text-2xl font-semibold tabular-nums mt-1">{n(v)}</p></Card>)}
      </div>}
      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nada com esses filtros" /> : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[620px]">
              <thead className="text-left text-muted"><tr>{['Unidade', 'Morador', 'Situação', 'Contato', 'Desde'].map((h) => <th key={h} className="py-2 pr-3 first:pl-4 sm:first:pl-0 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r, i) => (
                  <tr key={`${r.unit_id}-${r.user_id || i}`}>
                    <td className="py-2 pr-3 pl-4 sm:pl-0 whitespace-nowrap">{unitName(r.block, r.label)}{!r.unit_active && <span className="text-xs text-muted"> (inativa)</span>}</td>
                    <td className="pr-3">{r.full_name || <span className="text-muted">—</span>}{relationLabel(r.relation) && <span className="block text-xs text-muted">{relationLabel(r.relation)}</span>}</td>
                    <td className="pr-3">{r.status ? <Badge tone={RES_STATUS[r.status][1]}>{RES_STATUS[r.status][0]}</Badge> : <span className="text-muted">Sem morador</span>}</td>
                    <td className="pr-3 text-xs break-all">{r.email}{r.phone && <span className="block text-muted">{r.phone}</span>}</td>
                    <td className="text-xs text-muted whitespace-nowrap">{r.since ? dateTime(r.since, t.tenant.timezone) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
