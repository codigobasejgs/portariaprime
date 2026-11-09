// Importação de planilha de moradores (pré-cadastro). Função pura: nada sai daqui para o banco sem o síndico
// revisar a prévia. Não cria conta nem vínculo: só alimenta resident_import_entries (RPC resident_import_save).
import { phoneE164, validEmail, normEmail } from './resident-signup';

export interface ImportUnit { id: string; block: string | null; label: string; active?: boolean }
export interface Mapping { name: number | null; unit: number | null; block: number | null; apto: number | null; kind: number | null; phones: number[]; emails: number[] }
export interface ImportRow {
  line: number; unit_id: string; full_name: string; kind: string | null;
  phone: string | null; email: string | null; extra: { phones?: string[]; emails?: string[] };
}
export type Reason = 'sem_nome' | 'sem_unidade' | 'unidade_inexistente' | 'unidade_ambigua' | 'tipo_excluido' | 'unidade_vazia' | 'nao_morador' | 'duplicado';
export const REASONS: Record<Reason, string> = {
  sem_nome: 'Sem nome', sem_unidade: 'Sem unidade', unidade_inexistente: 'Unidade não existe no condomínio',
  unidade_ambigua: 'Unidade ambígua ou corrompida (ex.: virou data no Excel)', tipo_excluido: 'Autorizado, prestador ou funcionário',
  unidade_vazia: 'Unidade marcada como vazia', nao_morador: 'Marcado como não morador', duplicado: 'Repetido na planilha',
};
export interface ImportResult {
  mapping: Mapping; header: string[]; total: number; rows: ImportRow[];
  discards: Partial<Record<Reason, number>>; discarded: { line: number; reason: Reason }[];
  unitsSeen: number; unitsMatched: number; unitsWithPeople: number; withWhatsapp: number; withEmail: number;
}

export const MAX_ROWS = 5000;

// ---------------------------------------------------------------------------- leitura
/** UTF-8 estrito; se não for, windows-1252 (exportações antigas do Excel/sistemas de portaria). */
export function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** CSV/TSV com aspas; separador ; , ou TAB (o mais frequente na 1ª linha não vazia). Linhas vazias saem. */
export function parseDelimited(text: string): string[][] {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const sep = [';', ',', '\t'].map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  const end = () => { row.push(cur.trim()); cur = ''; if (row.some((x) => x)) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur.trim()); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; end(); }
    else cur += c;
  }
  end();
  return rows;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
/** Zip mínimo (diretório central): só os arquivos pedidos. */
async function unzip(b: Uint8Array, want: (name: string) => boolean): Promise<Map<string, string>> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Arquivo .xlsx inválido.');
  const out = new Map<string, string>();
  let p = u32(b, eocd + 16);
  for (let n = u16(b, eocd + 10); n > 0; n--) {
    if (u32(b, p) !== 0x02014b50) throw new Error('Arquivo .xlsx inválido.');
    const method = u16(b, p + 10), size = u32(b, p + 20), nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), off = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (!want(name)) continue;
    const start = off + 30 + u16(b, off + 26) + u16(b, off + 28);
    const raw = b.subarray(start, start + size);
    out.set(name, new TextDecoder().decode(method === 8 ? await inflateRaw(raw) : raw));
  }
  return out;
}
const unxml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#x?[0-9a-f]+);/gi, (_, e: string) =>
  ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[e.toLowerCase()]
  ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

/** Primeira planilha do .xlsx como matriz de textos. */
export async function parseXlsx(b: Uint8Array): Promise<string[][]> {
  const files = await unzip(b, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const sheet = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort((a, c) => parseInt(a.slice(19)) - parseInt(c.slice(19)))[0];
  if (!sheet) throw new Error('Planilha vazia.');
  const shared = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const rows: string[][] = [];
  for (const r of files.get(sheet)!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    let auto = 0;
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c[1])?.[1];
      const col = ref ? [...ref].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : auto;
      auto = col + 1;
      const t = /\bt="(\w+)"/.exec(c[1])?.[1], body = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      row[col] = (t === 's' ? shared[Number(v)] : t === 'inlineStr' ? texts(body) : unxml(v ?? '')) ?? '';
    }
    const cells = Array.from(row, (x) => (x ?? '').trim());
    if (cells.some((x) => x)) rows.push(cells);
  }
  return rows;
}

/** .csv/.txt/.tsv ou .xlsx. ponytail: .xls (BIFF/CFB) não é lido — pedir "Salvar como .xlsx/.csv"; leitor só se aparecer muito. */
export async function readTable(bytes: Uint8Array, fileName: string): Promise<string[][]> {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'xlsx' || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return parseXlsx(bytes);
  if (ext === 'xls' || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    throw new Error('Arquivo .xls (Excel antigo) não é suportado: abra no Excel e use "Salvar como" .xlsx ou .csv.');
  }
  return parseDelimited(decodeText(bytes));
}

// ---------------------------------------------------------------------------- colunas
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Mapeamento automático pelo cabeçalho (o síndico ajusta na prévia). */
export function autoMap(header: string[]): Mapping {
  const h = header.map(plain);
  const find = (re: RegExp, skip: number[] = []) => { const i = h.findIndex((x, k) => re.test(x) && !skip.includes(k)); return i < 0 ? null : i; };
  const unit = find(/^(UNIDADE|UNID|UN|APTO UNIDADE|ENDERECO UNIDADE)$|UNIDADE/);
  const block = find(/^(BLOCO|BL|TORRE|QUADRA|QD)\b/);
  const apto = find(/^(APTO|AP|APARTAMENTO|NUMERO|NUM|APTO NUM|CASA|LOTE)\b/);
  const name = find(/\bNOME\b|^(USUARIO|MORADOR|RESIDENTE|LOCATARIO|PROPRIETARIO|PESSOA)$/);
  const kind = find(/^(TIPO|PERFIL|VINCULO|RELACAO|CATEGORIA)\b/);
  const all = (re: RegExp) => h.flatMap((x, i) => (re.test(x) ? [i] : []));
  // Celular/WhatsApp antes do telefone fixo: o 1º celular válido vira o WhatsApp principal.
  const phones = [...all(/CELULAR|WHATS|MOVEL/), ...all(/TELEFONE|FONE|TEL\b/).filter((i) => !/CELULAR|WHATS|MOVEL/.test(h[i]) && !/RAMAL/.test(h[i]))];
  return { name, unit, block, apto, kind, phones, emails: all(/E ?MAIL/) };
}

// ---------------------------------------------------------------------------- unidades
/** Chave de comparação: sem prefixo (Bloco, Apto, Nº…), só A-Z0-9, sem zero à esquerda ("BLOCO 01A" = "1A"). */
export const unitKey = (s: string | null | undefined) => plain(s || '')
  .replace(/^(BLOCO|BL|TORRE|TR|QUADRA|QD|APARTAMENTO|APTO|AP|UNIDADE|UN|CASA|LOTE|LT|NUMERO|NUM|NO|N)(?: +|(?=\d))/, '')
  .replace(/ /g, '').replace(/^0+(?=\d)/, '');

// Excel transformou "1-11" em data (01/nov, 2024-11-01, 1/11/2024): o texto deixa de ser confiável.
const EXCEL_DATE = /^\d{1,2}[/-](jan|fev|feb|mar|abr|apr|mai|may|jun|jul|ago|aug|set|sep|out|oct|nov|dez|dec)\b|^\d{1,2}\/\d{1,2}\/\d{2,4}$|^\d{4}-\d{2}-\d{2}/i;

type Hit = { unit?: ImportUnit; reason?: 'unidade_inexistente' | 'unidade_ambigua' };

function unitIndex(units: ImportUnit[]) {
  const active = units.filter((u) => u.active !== false);
  const byKey = new Map(active.map((u) => [`${unitKey(u.block)}|${unitKey(u.label)}`, u]));
  const blocks = [...new Set(active.map((u) => unitKey(u.block)).filter(Boolean))];
  const match = (block: string | null, label: string, fromColumns = false): Hit => {
    const b = unitKey(block), l = unitKey(label);
    if (!l) return { reason: 'unidade_inexistente' };
    if (b) {
      // Coluna "Bloco" isolada "1" quando existem 1A/1B: pode ser bloco truncado — não adivinha.
      if (fromColumns && blocks.some((x) => x !== b && x.startsWith(b) && /^[A-Z]/.test(x.slice(b.length)))) return { reason: 'unidade_ambigua' };
      const u = byKey.get(`${b}|${l}`);
      return u ? { unit: u } : { reason: 'unidade_inexistente' };
    }
    const own = byKey.get(`|${l}`);
    if (own) return { unit: own };
    const many = active.filter((u) => unitKey(u.label) === l);
    return many.length === 1 ? { unit: many[0] } : { reason: many.length ? 'unidade_ambigua' : 'unidade_inexistente' };
  };
  /** "BLOCO 01A, N 1", "10A-11", "1A/1", "Bloco 3 Apto 12", "101" (sem bloco). */
  const parse = (text: string): [string | null, string] => {
    const t = text.trim();
    const m = /^(.+?)\s*[,;]\s*(.+)$/.exec(t) || /^([0-9A-Za-z]+)\s*[-/]\s*([0-9A-Za-z]+)$/.exec(t)
      || /^((?:BLOCO|BL|TORRE|QUADRA|QD)\.?\s*[0-9A-Za-z]+)\s+(.+)$/i.exec(plain(t));
    return m ? [m[1], m[2]] : [null, t];
  };
  return { match, parse, any: active.length > 0 };
}

// ---------------------------------------------------------------------------- pessoas
const KIND_IN = /^(MORADOR|MORADORA|PROPRIETARIO|PROPRIETARIA|LOCATARIO|LOCATARIA|INQUILINO|INQUILINA|RESIDENTE|DEPENDENTE|TITULAR|CONJUGE)$/;
const KIND_OUT = /^(AUTORIZADO|AUTORIZADA|PRESTADOR|PRESTADORA|FUNCIONARIO|FUNCIONARIA|VISITANTE|EMPREGADO|EMPREGADA)/;
const STAFF_TAG = /\b(PORTARIA|LIMPEZA|JARDINEIRO|JARDINEIRA|MERCADINHO|RECICLADO|RECICLAGEM|FUNCIONARIO|FUNCIONARIA|PRESTADOR)\b/;
const EMPTY_TAG = /\b(AP|APTO|APARTAMENTO|UNIDADE|CASA)? ?VAZI[OA]\b/;
const NOT_RESIDENT = /\bNAO MORADOR|\bNAO RESIDE/;

/** Valor de célula sem conteúdo real: "-", "( ) -", "+55 (00) 0000-0000", "0000". */
const isBlank = (v: string | undefined) => !/[A-Za-z1-9]/.test((v || '').trim().replace(/^\+\s*55\b/, ''));

function contacts(cells: string[]) {
  const phones: string[] = [], other: string[] = [], emails: string[] = [];
  for (const c of cells) for (const part of (c || '').split(/[|,;\n]/)) {
    if (isBlank(part)) continue;
    if (part.includes('@')) { const e = normEmail(part); if (validEmail(e) && !emails.includes(e)) emails.push(e); continue; }
    const p = phoneE164(part);
    if (p) { if (!phones.includes(p)) phones.push(p); continue; }
    // Fixo/outro formato com DDD: fica como contato extra (não recebe WhatsApp).
    const d = part.replace(/\D/g, '').replace(/^55(?=\d{10})/, '');
    if (d.length === 10 && Number(d.slice(0, 2)) >= 11 && !other.includes(d)) other.push(d);
  }
  return { phone: phones[0] || null, email: emails[0] || null, extra: { phones: [...phones.slice(1), ...other], emails: emails.slice(1) } };
}

/**
 * Planilha → pré-cadastros válidos + descartes por motivo. `table[0]` é o cabeçalho.
 * includeOthers: inclui autorizados/prestadores/funcionários (desmarcado por padrão).
 */
export function buildImport(table: string[][], units: ImportUnit[], opts: { mapping?: Mapping; includeOthers?: boolean } = {}): ImportResult {
  const header = table[0] || [];
  const mapping = opts.mapping || autoMap(header);
  const idx = unitIndex(units);
  const rows: ImportRow[] = [], discarded: { line: number; reason: Reason }[] = [];
  const seen = new Set<string>(), matched = new Set<string>(), byPerson = new Map<string, ImportRow>();
  const cell = (r: string[], i: number | null) => (i == null ? '' : (r[i] || '').trim());
  const data = table.slice(1, MAX_ROWS + 1);
  data.forEach((r, k) => {
    const line = k + 2;
    const drop = (reason: Reason) => discarded.push({ line, reason });
    // Unidade: texto da coluna "Unidade" primeiro; colunas Bloco/Apto só se ele faltar, não casar ou estiver corrompido.
    const text = cell(r, mapping.unit), bcol = cell(r, mapping.block), acol = cell(r, mapping.apto);
    let hit: Hit = {};
    const textOk = !isBlank(text) && !EXCEL_DATE.test(text);
    if (textOk) { const [b, l] = idx.parse(text); seen.add(`${unitKey(b)}|${unitKey(l)}`); hit = idx.match(b, l); }
    else if (!isBlank(text)) seen.add(`?${text}`);
    else if (!isBlank(acol)) seen.add(`${unitKey(bcol)}|${unitKey(acol)}`);
    if (!hit.unit && !isBlank(acol)) {
      const alt = idx.match(isBlank(bcol) ? null : bcol, acol, true);
      if (alt.unit) hit = alt;
      else if (!textOk) hit = { reason: isBlank(text) ? alt.reason : 'unidade_ambigua' };
      else if (alt.reason === 'unidade_ambigua') hit = alt;
    }
    if (!hit.unit && !isBlank(text) && !textOk && !hit.reason) hit = { reason: 'unidade_ambigua' };
    if (hit.unit) matched.add(hit.unit.id);

    const rawName = cell(r, mapping.name).replace(/\s+/g, ' ');
    // Observações entre parênteses (fechados ou não): "(FILHO)", "(AP VAZIO", "(PORTARIA)".
    const tags = plain([...rawName.matchAll(/\(([^)]*)(?:\)|$)/g)].map((m) => m[1]).join(' '));
    const name = rawName.replace(/\s*\([^)]*(?:\)|$)\s*/g, ' ').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    const kindRaw = plain(cell(r, mapping.kind));
    if (isBlank(name) || name.length < 2) return drop('sem_nome');
    if (!hit.unit) return drop(hit.reason || 'sem_unidade');
    if (NOT_RESIDENT.test(tags)) return drop('nao_morador');
    if (EMPTY_TAG.test(tags)) return drop('unidade_vazia');
    if (!opts.includeOthers && (KIND_OUT.test(kindRaw) || STAFF_TAG.test(tags))) return drop('tipo_excluido');

    const c = contacts(mapping.phones.map((i) => cell(r, i)).concat(mapping.emails.map((i) => cell(r, i))));
    const kind = KIND_IN.test(kindRaw) || KIND_OUT.test(kindRaw) ? kindRaw.toLowerCase() : kindRaw ? kindRaw.toLowerCase().slice(0, 30) : null;
    const pk = `${hit.unit.id}|${plain(name)}`;
    const prev = byPerson.get(pk);
    if (prev) {
      // Mesma pessoa repetida na unidade: junta os contatos na primeira linha.
      const ph = [c.phone, ...(c.extra.phones || [])].filter((x): x is string => !!x && x !== prev.phone && !prev.extra.phones?.includes(x));
      const em = [c.email, ...(c.extra.emails || [])].filter((x): x is string => !!x && x !== prev.email && !prev.extra.emails?.includes(x));
      if (!prev.phone && ph[0]?.startsWith('+')) prev.phone = ph.shift()!;
      if (!prev.email && em[0]) prev.email = em.shift()!;
      prev.extra = { phones: [...(prev.extra.phones || []), ...ph], emails: [...(prev.extra.emails || []), ...em] };
      return drop('duplicado');
    }
    const row: ImportRow = { line, unit_id: hit.unit.id, full_name: name.slice(0, 120), kind, phone: c.phone, email: c.email, extra: c.extra };
    byPerson.set(pk, row);
    rows.push(row);
  });
  const discards: Partial<Record<Reason, number>> = {};
  for (const d of discarded) discards[d.reason] = (discards[d.reason] || 0) + 1;
  for (const r of rows) {
    if (!r.extra.phones?.length) delete r.extra.phones;
    if (!r.extra.emails?.length) delete r.extra.emails;
  }
  const withPeople = new Set(rows.map((r) => r.unit_id));
  return {
    mapping, header, total: data.length, rows, discards, discarded,
    unitsSeen: seen.size, unitsMatched: matched.size, unitsWithPeople: withPeople.size,
    withWhatsapp: new Set(rows.filter((r) => r.phone).map((r) => r.unit_id)).size,
    withEmail: rows.filter((r) => r.email).length,
  };
}
