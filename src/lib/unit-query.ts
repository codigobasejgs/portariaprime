// Busca de unidades para listas grandes (Pessoas): pura, sem rede.
// Aceita "15B-22", "15B 22", "01A-3", "1A/11", "BLOCO 01A, N 3", "quadra 3 lote 10", "1A" (só bloco) ou "22" (só número).
// Zeros à esquerda não contam: "01A" ≡ "1A", "003" ≡ "3". Acentos e caixa ignorados.
export interface QueryUnit { block: string | null; label: string }

export const normText = (s: string | null | undefined) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const PREFIX = /\b(?:apartamento|apto|apt|ap|unidade|un|bloco|bl|torre|tr|quadra|qd|lote|lt|casa|cs|sala|numero|num|no|n)\b\.?/g;
const clean = (s: string) => normText(s).replace(/n[º°]/g, ' ').replace(/[º°]/g, ' ').replace(PREFIX, ' ');

/** Código comparável: sem prefixos, separadores nem zeros à esquerda ("Bloco 01A" → "1a"). */
export const unitCode = (s: string | null | undefined) =>
  clean(s || '').replace(/[^a-z0-9]+/g, '').replace(/(^|[^0-9])0+(?=\d)/g, '$1');

/** Tokens de unidade da consulta, ou null quando parece nome de pessoa (sem dígito e com palavra longa). */
export function parseUnitQuery(q: string): string[] | null {
  const tokens = clean(q).split(/[\s\-/,;.]+/).map(unitCode).filter(Boolean);
  if (!tokens.length) return null;
  if (!tokens.some((t) => /\d/.test(t)) && tokens.some((t) => t.length > 3)) return null;
  return tokens;
}

/** 0 = não casa; 1 = prefixo do número; 2 = exato. */
export function unitScore(u: QueryUnit, q: string): number {
  const t = parseUnitQuery(q);
  if (!t) return 0;
  const b = unitCode(u.block), l = unitCode(u.label);
  if (t.length === 1) {
    const [x] = t;
    if (x === l || x === b || x === b + l) return 2;
    return l.startsWith(x) || (b + l).startsWith(x) ? 1 : 0;
  }
  const qb = t.slice(0, -1).join(''), ql = t[t.length - 1];
  if (qb !== b) return 0;
  return ql === l ? 2 : l.startsWith(ql) ? 1 : 0;
}

/** Todas as palavras da consulta aparecem no texto (sem acento/caixa). */
export const textMatches = (haystack: string, q: string) => {
  const h = normText(haystack);
  return normText(q).split(' ').every((w) => h.includes(w));
};

/** Ordem natural: "1A" < "2A" < "10B". */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });

/** Blocos distintos (para o filtro), em ordem natural; "01A" e "1A" viram um só. */
export function distinctBlocks(units: QueryUnit[]): { key: string; label: string }[] {
  const m = new Map<string, string>();
  for (const u of units) if (u.block && !m.has(unitCode(u.block))) m.set(unitCode(u.block), u.block);
  return [...m].map(([key, label]) => ({ key, label })).sort((x, y) => naturalCompare(x.label, y.label));
}
