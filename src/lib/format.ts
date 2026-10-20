export const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dateTime = (iso: string | null | undefined, tz?: string) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '—';

export const dateOnly = (iso: string | null | undefined, tz?: string) =>
  iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: tz }) : '—';

export const CYCLE_LABEL: Record<string, string> = { monthly: 'Mensal', quarterly: 'Trimestral', yearly: 'Anual' };
export const CYCLE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export const STATUS_LABEL: Record<string, string> = {
  PRE_REGISTRADA: 'Aguardando conferência',
  RECEBIDA: 'Recebida',
  ARMAZENADA: 'Guardada',
  RETIRADA: 'Retirada',
  CANCELADA: 'Cancelada',
  DEVOLVIDA: 'Devolvida',
  EXTRAVIADA: 'Extraviada',
};

export const unitName = (block?: string | null, label?: string | null) =>
  [block ? `Bloco ${block}` : null, label].filter(Boolean).join(' · ') || '—';

export const CARRIERS = ['Correios', 'Mercado Livre', 'Amazon', 'Shopee', 'Loggi', 'Outra'];

/** CSV seguro: escapa aspas e neutraliza fórmulas (=, +, -, @, tab, CR). */
export function toCsv(rows: Record<string, unknown>[], cols: [string, string][]) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return '﻿' + [cols.map(([, h]) => cell(h)).join(';'), ...rows.map((r) => cols.map(([k]) => cell(r[k])).join(';'))].join('\r\n');
}

export function download(name: string, content: string, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** CSV simples (separador ; ou ,) com aspas. */
export function parseCsv(text: string): string[][] {
  const sep = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows.map((r) => r.map((x) => x.replace(/^﻿/, '').trim()));
}
