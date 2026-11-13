/**
 * Sugestões de preenchimento: valores já usados neste condomínio. Junta o que este aparelho lembra
 * (último uso primeiro) com o que aparece nas encomendas recentes, sem repetir (ignora maiúsculas e acentos).
 * ponytail: memória por aparelho (localStorage); passar para o servidor se a portaria trocar muito de aparelho.
 */
const key = (tenant: string, field: string) => `pp_recent:${tenant}:${field}`;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export function recall(tenant: string, field: string): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(key(tenant, field)) || '[]');
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && v.trim().length >= 2 && v.length <= 500).slice(0, 12) : [];
  } catch { return []; }
}

export function remember(tenant: string, field: string, value: string | null | undefined) {
  const v = (value || '').trim();
  if (v.length < 2) return;
  try {
    const list = [v, ...recall(tenant, field).filter((x) => norm(x) !== norm(v))].slice(0, 12);
    localStorage.setItem(key(tenant, field), JSON.stringify(list));
  } catch { /* armazenamento indisponível: as sugestões fixas e as do histórico continuam */ }
}

/** Lista final: lembrados, depois os mais frequentes no histórico, depois os fixos. */
export function suggestions(remembered: string[], seen: (string | null | undefined)[], fixed: readonly string[] = [], max = 8): string[] {
  const count = new Map<string, { v: string; n: number }>();
  for (const s of seen) { const v = (s || '').trim(); if (v.length >= 2) { const k = norm(v); count.set(k, { v: count.get(k)?.v || v, n: (count.get(k)?.n || 0) + 1 }); } }
  const frequent = [...count.values()].sort((a, b) => b.n - a.n).map((x) => x.v);
  const out: string[] = [];
  for (const v of [...remembered, ...frequent, ...fixed]) if (!out.some((x) => norm(x) === norm(v))) out.push(v);
  return out.slice(0, max);
}

/** Mesmo valor com outra grafia ("correios" → "Correios"): usa a grafia já conhecida. */
export const canonical = (value: string, known: readonly string[]) => known.find((k) => norm(k) === norm(value)) || value.trim();
