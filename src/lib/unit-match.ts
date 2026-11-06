// Busca de unidade por texto, pura (sem rede): "a 101", "quadra 3 lote 10", "rua das palmeiras casa 12".
// Prefixos verticais e horizontais são ignorados só como palavra inteira ("Alameda das Rosas" não perde "al").
export interface MatchableUnit { id: string; block: string | null; label: string; active: boolean }

const PREFIX = /\b(?:apartamento|apto|apt|ap|unidade|un|bloco|bl|torre|tr|quadra|qd|lote|lt|casa|cs|chacara|numero|num)\b\.?/g;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(PREFIX, ' ').replace(/\s+/g, ' ').trim();

export function matchUnits<T extends MatchableUnit>(units: T[], q: string): T[] {
  const query = norm(q);
  if (!query) return units.filter((u) => u.active).slice(0, 30);
  const parts = query.split(' ');
  return units.filter((u) => u.active && parts.every((p) => norm(`${u.block || ''} ${u.label}`).includes(p))).slice(0, 30);
}
