// Pergunta em português → filtros do relatório de encomendas. Determinístico (sem IA): o resultado é
// sempre o que os filtros exibidos na tela mostram, e o servidor revalida tudo. O que não for entendido
// é devolvido em `ignored` para a tela avisar (nunca inventa filtro).

export interface QueryContext {
  today: string; // YYYY-MM-DD no fuso do condomínio
  blocks: string[];
  units: { id: string; block: string | null; label: string }[];
  carriers: string[];
}
export interface ParsedQuery { filters: Record<string, string>; ranking: number | null; understood: string[]; ignored: string[] }

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const NUM: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, vinte: 20 };
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (ymd: string, d: number) => { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

export function parseReportQuery(text: string, ctx: QueryContext): ParsedQuery {
  const q = ` ${strip(text).replace(/[^\p{L}\p{N}\s/-]/gu, ' ').replace(/\s+/g, ' ')} `;
  const f: Record<string, string> = {};
  const understood: string[] = [];
  let ranking: number | null = null;
  const [y, m] = ctx.today.split('-').map(Number);

  // Situação.
  if (/ (pendente|aguardando|nao retirad|parad)/.test(q)) { f.status = 'PENDENTES'; understood.push('pendentes'); }
  else if (/ (retirad|entregue)/.test(q)) { f.status = 'RETIRADA'; understood.push('retiradas'); }
  else if (/ extraviad/.test(q)) { f.status = 'EXTRAVIADA'; understood.push('extraviadas'); }
  else if (/ devolvid/.test(q)) { f.status = 'DEVOLVIDA'; understood.push('devolvidas'); }
  else if (/ cancelad/.test(q)) { f.status = 'CANCELADA'; understood.push('canceladas'); }

  // Ranking: "ranking das dez unidades", "top 5", "as 10 unidades que mais receberam".
  const rk = q.match(/ (?:ranking|top|as|os)\s+(?:d[ao]s?\s+)?(\d{1,2}|[a-z]+)\s+(?:unidades|apartamentos|aptos)/) || (/ (ranking|que mais receberam| mais encomendas)/.test(q) ? [null, '10'] : null);
  if (rk) { ranking = Math.min(Number(rk[1]) || NUM[rk[1] as string] || 10, 50); understood.push(`ranking das ${ranking} unidades`); }

  // Período.
  const mm = q.match(new RegExp(` (?:em|de|no mes de)?\\s*(${MONTHS.join('|')})(?: de (\\d{4}))?`));
  if (/ (este|neste|esse|desse|no) ano | anual /.test(q)) { f.received_from = `${y}-01-01`; f.received_to = ctx.today; understood.push(`ano de ${y}`); }
  else if (/ ano passado /.test(q)) { f.received_from = `${y - 1}-01-01`; f.received_to = `${y - 1}-12-31`; understood.push(`ano de ${y - 1}`); }
  else if (/ (este|neste|esse) mes /.test(q)) { f.received_from = `${y}-${pad(m)}-01`; f.received_to = ctx.today; understood.push('este mês'); }
  else if (/ mes passado /.test(q)) { const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; f.received_from = `${py}-${pad(pm)}-01`; f.received_to = `${py}-${pad(pm)}-${lastDay(py, pm)}`; understood.push('mês passado'); }
  else if (/ hoje /.test(q)) { f.received_from = ctx.today; f.received_to = ctx.today; understood.push('hoje'); }
  else if (/ ontem /.test(q)) { f.received_from = f.received_to = addDays(ctx.today, -1); understood.push('ontem'); }
  else if (q.match(/ (?:ultimos|ultimas) (\d{1,3}) dias /)) { const d = Number(q.match(/ (?:ultimos|ultimas) (\d{1,3}) dias /)![1]); f.received_from = addDays(ctx.today, -(d - 1)); f.received_to = ctx.today; understood.push(`últimos ${d} dias`); }
  else if (/ (ultima|nesta|esta) semana /.test(q)) { f.received_from = addDays(ctx.today, -6); f.received_to = ctx.today; understood.push('últimos 7 dias'); }
  else if (mm) { const mi = MONTHS.indexOf(mm[1]) + 1; const yy = mm[2] ? Number(mm[2]) : (mi > m ? y - 1 : y); f.received_from = `${yy}-${pad(mi)}-01`; f.received_to = `${yy}-${pad(mi)}-${lastDay(yy, mi)}`; understood.push(`${mm[1]} de ${yy}`); }
  else if (q.match(/ (?:em|de|no ano de|ano) (20\d\d) /)) { const yy = q.match(/ (?:em|de|no ano de|ano) (20\d\d) /)![1]; f.received_from = `${yy}-01-01`; f.received_to = `${yy}-12-31`; understood.push(`ano de ${yy}`); }
  if (/ (paradas?|ha mais de) (3 dias|72 ?h|72 horas|tres dias) /.test(q)) { f.status = 'PENDENTES'; f.received_to = addDays(ctx.today, -3); delete f.received_from; understood.push('paradas há mais de 72 h'); }

  // Bloco: "bloco A", "torre 2". Só se existir no condomínio.
  const bm = q.match(/ (?:bloco|torre|bl) ([\p{L}\p{N}]{1,10}) /u);
  let block: string | undefined;
  if (bm) block = ctx.blocks.find((b) => strip(b) === bm[1]);
  if (block) { f.block = block; understood.push(`bloco ${block}`); }

  // Unidade: "apartamento 204", "apto 204", "unidade 12", "casa 3". Só unidade existente (no bloco, se dito).
  const um = q.match(/ (?:apartamento|apto|ap|unidade|casa|sala) ([\p{L}\p{N}-]{1,10}) /u);
  if (um) {
    const cands = ctx.units.filter((u) => strip(u.label).replace(/^(apto|ap|casa|sala)\s*/, '') === um[1] && (!block || u.block === block));
    if (cands.length === 1) { f.unit = cands[0].id; understood.push(`unidade ${[cands[0].block, cands[0].label].filter(Boolean).join(' ')}`); }
    else if (cands.length > 1) understood.push(`unidade ${um[1]} existe em ${cands.length} blocos — escolha o bloco`);
  }

  // Transportadora / origem (as que existem no condomínio).
  for (const c of ctx.carriers) {
    if (q.includes(` ${strip(c)} `)) { f.carrier = c; understood.push(c); break; }
  }

  // Palavras sem efeito (conectivos) não contam como ignoradas.
  const known = /^(encomendas?|pacotes?|correspondencias?|relatorio|executivo|do|da|de|dos|das|no|na|nos|nas|em|e|o|a|os|as|que|mais|com|por|para|graficos?|condominio|lista|quais|quantas?|mostrar?|ver|todas?|apartamento|apto|ap|unidade|unidades|casa|sala|bloco|torre|receberam|recebidas?|ano|mes|dias|ultimos|ultimas|ate|desde|ranking|top|\d+|[a-z])$/;
  const leftovers = q.trim().split(' ').filter((w) => w && !known.test(w)
    && !understood.some((u) => strip(u).includes(w)) && !MONTHS.includes(w) && !Object.keys(NUM).includes(w)
    && !/^(pendentes?|aguardando|nao|retirad\w*|entregues?|parad\w*|extraviad\w*|devolvid\w*|cancelad\w*|hoje|ontem|semana|passad\w|este|neste|esse|desse|nesta|esta|ultima|anual|ha|horas|72h|tres)$/.test(w)
    && !ctx.carriers.some((c) => strip(c).split(' ').includes(w)));
  return { filters: f, ranking, understood, ignored: [...new Set(leftovers)] };
}
