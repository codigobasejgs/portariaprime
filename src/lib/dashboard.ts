// Dashboard executivo do síndico: períodos no fuso do condomínio, insights determinísticos
// (cada um com o número que o fundamenta) e tabelas para exportação. Sem React; testável.
import { DEFAULT_UNIT_LABELS, STATUS_LABEL, toCsv, unitName, type UnitLabels } from './format';
import { xlsx, type Cell } from './xlsx';

export const MAX_DAYS = 366; // diferença máxima aceita pela RPC (p_to - p_from)
export const OVERDUE_HOURS_FALLBACK = 72;

export const PRESETS = [
  ['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'],
  ['mes', 'Mês atual'], ['mes_ant', 'Mês anterior'], ['tri', 'Trimestre atual'], ['tri_ant', 'Trimestre anterior'],
  ['sem', 'Semestre atual'], ['sem_ant', 'Semestre anterior'], ['ano', 'Ano atual'], ['ano_ant', 'Ano anterior'],
  ['custom', 'Personalizado'],
] as const;
export type Preset = (typeof PRESETS)[number][0];

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const parts = (s: string) => s.split('-').map(Number) as [number, number, number];
export const addDays = (s: string, n: number) => { const [y, m, d] = parts(s); return iso(y, m - 1, d + n); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
/** Data de hoje (AAAA-MM-DD) no fuso do condomínio. */
export const todayIn = (tz: string, now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: tz });

/** Intervalo [from, to] do atalho, calculado a partir de "hoje" no fuso do condomínio. Períodos correntes terminam hoje. */
export function presetRange(p: Exclude<Preset, 'custom'>, today: string): { from: string; to: string } {
  const [y, m] = parts(today); const mi = m - 1;
  const block = (size: number, back: number) => {
    const start = Math.floor(mi / size) * size - back * size;
    return { from: iso(y, start, 1), to: back ? iso(y, start + size, 0) : today };
  };
  switch (p) {
    case 'hoje': return { from: today, to: today };
    case 'ontem': { const d = addDays(today, -1); return { from: d, to: d }; }
    case '7': return { from: addDays(today, -6), to: today };
    case '30': return { from: addDays(today, -29), to: today };
    case 'mes': return block(1, 0);
    case 'mes_ant': return block(1, 1);
    case 'tri': return block(3, 0);
    case 'tri_ant': return block(3, 1);
    case 'sem': return block(6, 0);
    case 'sem_ant': return block(6, 1);
    case 'ano': return { from: iso(y, 0, 1), to: today };
    case 'ano_ant': return { from: iso(y - 1, 0, 1), to: iso(y - 1, 11, 31) };
  }
}

/** Mensagem de erro do período personalizado, ou null se válido. */
export function rangeError(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'Informe as duas datas.';
  if (to < from) return 'A data final é anterior à inicial.';
  if (daysBetween(from, to) > MAX_DAYS) return 'Período máximo de 1 ano.';
  return null;
}

export interface Filters { block?: string; unit?: string; status?: string; carrier?: string }
export const cleanFilters = (f: Filters): Filters => {
  const out: Record<string, string> = {};
  for (const k of ['block', 'unit', 'status', 'carrier'] as const) if (f[k]) out[k] = f[k]!;
  return out;
};

export const pct = (v: number | null | undefined, digits = 0) => v == null ? '—' : `${(v * 100).toFixed(digits).replace('.', ',')}%`;
export const hours = (v: number | null | undefined) => v == null ? '—' : `${String(v).replace('.', ',')} h`;
export const num = (v: unknown) => Number(v || 0).toLocaleString('pt-BR');
const DOW_FULL = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];
const br = (s: string) => s.split('-').reverse().join('/');
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function bucketLabel(s: { start: string; end: string }, gran: string) {
  if (gran === 'month') { const [y, m] = parts(s.start); return `${MONTHS[m - 1]}/${String(y).slice(2)}`; }
  if (gran === 'week') return `${br(s.start).slice(0, 5)}–${br(s.end).slice(0, 5)}`;
  return br(s.start).slice(0, 5);
}
export const periodLabel = (from: string, to: string) => from === to ? br(from) : `${br(from)} a ${br(to)}`;
export const unitLabel = unitName;

export interface Insight { id: string; text: string; basis: string; tone?: 'warning' }

/** Insights calculados dos agregados. Só constatações do período; nenhuma previsão. */
export function insights(d: any, labels: UnitLabels = DEFAULT_UNIT_LABELS): Insight[] {
  const out: Insight[] = [];
  const r = d.received;
  if (r.change != null && r.change !== 0) {
    out.push({ id: 'growth', text: `Recebimentos ${r.change > 0 ? 'cresceram' : 'caíram'} ${pct(Math.abs(r.change))} em relação ao período anterior.`,
      basis: `${num(r.previous)} → ${num(r.value)} encomendas` });
  }
  const blocks = (d.blocks || []).filter((b: any) => b.received > 0);
  if (blocks.length >= 2 && r.value > 0) {
    const b = blocks[0];
    out.push({ id: 'block', text: `${unitName(b.block, null, labels)} concentra ${pct(b.received / r.value)} das recebidas no período.`, basis: `${num(b.received)} de ${num(r.value)}` });
  }
  const e = d.efficiency;
  if (e.within_48h != null) {
    const now = 1 - e.within_48h, before = e.within_48h_previous == null ? null : 1 - e.within_48h_previous;
    if (before != null && now > before) out.push({ id: 'late', tone: 'warning', text: 'Aumentaram as retiradas feitas depois de 48 h.', basis: `${pct(before)} → ${pct(now)} das entregas` });
    else if (now > 0) out.push({ id: 'late', text: `${pct(now)} das entregas do período levaram mais de 48 h.`, basis: `${num(Math.round(now * d.delivered.value))} de ${num(d.delivered.value)}` });
  }
  const heat: { dow: number; hour: number; n: number }[] = d.heatmap || [];
  if (heat.length) {
    const byDow = new Map<number, number>(), byHour = new Map<number, number>();
    for (const h of heat) { byDow.set(h.dow, (byDow.get(h.dow) || 0) + h.n); byHour.set(h.hour, (byHour.get(h.hour) || 0) + h.n); }
    const top = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const [dw, dn] = top(byDow), [hr, hn] = top(byHour);
    out.push({ id: 'peak', text: `Maior movimento: ${DOW_FULL[dw - 1]}; horário de pico entre ${hr}h e ${hr + 1}h.`, basis: `${num(dn)} recebidas no dia · ${num(hn)} no horário` });
  }
  const c = d.concentration;
  if (c && c.total_received > 0 && d.units_moved.value > c.top_units) {
    out.push({ id: 'units', text: `${c.top_units} ${c.top_units === 1 ? 'unidade concentra' : 'unidades concentram'} ${pct(c.top_received / c.total_received)} do volume recebido.`,
      basis: `${num(c.top_received)} de ${num(c.total_received)} · ${num(d.units_moved.value)} unidades movimentadas` });
  }
  if (d.overdue_now > 0) out.push({ id: 'overdue', tone: 'warning', text: `Há encomendas aguardando há mais de ${d.overdue_hours} h.`, basis: `${num(d.overdue_now)} de ${num(d.pending_now)} aguardando` });
  return out;
}

const filterText = (f: Filters, d: any, labels: UnitLabels) => {
  const unit = f.unit && (d.options?.units || []).find((u: any) => u.id === f.unit);
  return [f.block && unitName(f.block, null, labels), unit && `Unidade ${unitName(unit.block, unit.label, labels)}`,
    f.status && (f.status === 'PENDENTES' ? 'Pendentes' : STATUS_LABEL[f.status] || f.status), f.carrier].filter(Boolean).join(' · ') || 'Nenhum';
};

/** Tabelas exportadas (mesmo conteúdo da tela): indicadores, ranking e série. */
export function exportTables(d: any, ranking: any[], tenantName: string, labels: UnitLabels = DEFAULT_UNIT_LABELS): { name: string; rows: Cell[][] }[] {
  const ch = (x: { change: number | null }) => x.change == null ? '' : pct(x.change, 1);
  const kpis: Cell[][] = [
    ['Condomínio', tenantName, '', ''],
    ['Período', periodLabel(d.from, d.to), 'Anterior', periodLabel(d.previous.from, d.previous.to)],
    ['Filtros', filterText(d.filters || {}, d, labels), '', ''],
    ['Indicador', 'Valor', 'Período anterior', 'Variação'],
    ['Recebidas', d.received.value, d.received.previous, ch(d.received)],
    ['Entregues', d.delivered.value, d.delivered.previous, ch(d.delivered)],
    ['Taxa de retirada (coorte)', pct(d.cohort.rate, 1), '', ''],
    ['Aguardando retirada agora', d.pending_now, '', ''],
    [`Atrasadas (> ${d.overdue_hours} h)`, d.overdue_now, '', ''],
    ['Tempo médio até retirada (h)', d.pickup_time.avg_h, d.pickup_time.avg_h_previous, ch(d.pickup_time)],
    ['Mediana até retirada (h)', d.pickup_time.median_h, '', ''],
    ['Unidades movimentadas', d.units_moved.value, d.units_moved.previous, ch(d.units_moved)],
    ['Entregues em até 24 h', pct(d.efficiency.within_24h, 1), '', ''],
    ['Entregues em até 48 h', pct(d.efficiency.within_48h, 1), pct(d.efficiency.within_48h_previous, 1), ''],
    ['Recebimento → aviso, mediana (h)', d.efficiency.receipt_to_notice.median_h, '', ''],
    ['Aviso → retirada, mediana (h)', d.efficiency.notice_to_pickup.median_h, '', ''],
  ];
  const rank: Cell[][] = [['Posição', labels.group, labels.number, 'Recebidas', 'Entregues', 'Pendentes', '% do total', 'Variação', 'Tempo médio (h)'],
    ...ranking.map((u, i) => [i + 1, u.block || '', u.unit, u.received, u.delivered, u.pending, pct(u.share, 1), u.change == null ? '' : pct(u.change, 1), u.avg_pickup_h])];
  const series: Cell[][] = [['Início', 'Fim', 'Recebidas', 'Entregues', 'Saldo pendente no fim'],
    ...d.series.map((s: any) => [br(s.start), br(s.end), s.received, s.delivered, s.balance])];
  return [{ name: 'Indicadores', rows: kpis }, { name: 'Ranking de unidades', rows: rank }, { name: 'Série', rows: series }];
}

/** CSV (BOM UTF-8, separador ;) com as seções separadas por linha em branco. */
export function exportCsv(tables: { name: string; rows: Cell[][] }[]) {
  return '﻿' + tables.map(({ name, rows }) => {
    const [head, ...body] = rows;
    const cols = head.map((h, i) => [String(i), String(h ?? '')] as [string, string]);
    const objs = body.map((r) => { const o: Record<string, unknown> = {}; r.forEach((v, i) => { o[String(i)] = v; }); return o; });
    return `"${name}"\r\n` + toCsv(objs, cols).replace(/^﻿/, '');
  }).join('\r\n\r\n');
}

export const exportXlsx = (tables: { name: string; rows: Cell[][] }[]) => xlsx(tables);

export const exportName = (slug: string, from: string, to: string, ext: string) => `painel-${slug}-${from}-a-${to}.${ext}`;
