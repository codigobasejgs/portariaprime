// Gerador de unidades (blocos × apartamentos): partes puras, testáveis sem navegador.

/** Nomes dos blocos: números (1, 2…), letras (A, B…), nomes livres ou sem bloco. */
export function blockNames(style: 'numero' | 'letra' | 'nome' | 'sem', count: number, names: string) {
  if (style === 'sem') return [''];
  if (style === 'nome') return names.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 60);
  const k = Math.min(Math.max(count, 1), 60);
  return Array.from({ length: k }, (_, i) => (style === 'numero' ? String(i + 1)
    : (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26))));
}
