// Documentos legais: minutas empacotadas (docs/legal), parser de frontmatter e
// renderização de markdown simples SEM HTML cru (só elementos React; texto escapado pelo React).
import React from 'react';
import contratoMd from '../../docs/legal/contrato-saas.md?raw';
import termosMd from '../../docs/legal/termos.md?raw';
import privacidadeMd from '../../docs/legal/privacidade.md?raw';
import anexoMd from '../../docs/legal/anexo-tratamento-dados.md?raw';
import { headings, parseDraft, slug } from './legal-text';

export { headings, parseDraft };

export type LegalKind = 'contrato_saas' | 'termos' | 'privacidade' | 'anexo_dados' | 'politica_comercial';
export const LEGAL_LABEL: Record<LegalKind, string> = {
  contrato_saas: 'Contrato de prestação de serviços', termos: 'Termos de uso', privacidade: 'Política de privacidade',
  anexo_dados: 'Anexo de tratamento de dados', politica_comercial: 'Política comercial',
};

export interface LegalDoc { kind: LegalKind; version: string; content_md: string; summary: string | null; sha256?: string; effective_from?: string | null }

const RAW: Partial<Record<LegalKind, string>> = { contrato_saas: contratoMd, termos: termosMd, privacidade: privacidadeMd, anexo_dados: anexoMd };
/** Minuta local (não vigente). Marcadores {{CAMPO}} aparecem como "a definir", nunca com dado inventado. */
export function draftDoc(kind: LegalKind): LegalDoc | null {
  const raw = RAW[kind];
  if (!raw) return null;
  const { meta, body } = parseDraft(raw);
  return { kind, version: meta.version || '0.1-rascunho', summary: meta.summary || null, content_md: body };
}
export const DRAFT_KINDS = Object.keys(RAW) as LegalKind[];

/** Campos preenchidos na contratação (aparecem com o nome no modelo público). */
const CLIENT_FIELD: Record<string, string> = {
  CONDOMINIO_NOME: 'nome do condomínio', CONDOMINIO_CNPJ: 'CNPJ/CPF do condomínio', CONDOMINIO_ENDERECO: 'endereço do condomínio',
  SINDICO_NOME: 'nome do síndico', SINDICO_CPF: 'CPF do síndico', SINDICO_EMAIL: 'e-mail do síndico', SINDICO_TELEFONE: 'WhatsApp do síndico',
  PLANO_NOME: 'plano escolhido', PLANO_VALOR_MENSAL: 'valor mensal', PLANO_VALOR_EXTENSO: 'valor por extenso', PLANO_LIMITE_DESCRICAO: 'limites do plano',
  TAXA_IMPLANTACAO_DESCRICAO: 'taxa de implantação', DATA_INICIO_TRIAL: 'início do teste', DATA_FIM_TRIAL: 'fim do teste', DIA_VENCIMENTO: 'dia de vencimento',
  DATA_EXTENSO_CONTRATO: 'data da contratação', AUTENTIQUE_DOCUMENT_ID: 'ID na Autentique', CONTRACT_SHA256_HASH: 'hash do documento',
};

/** Inline: **negrito**, `código`, {{CAMPO}} e [PENDENTE…] destacados. Links viram texto (sem href arbitrário). */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\{\{[A-Z0-9_]+\}\}|\[(?:PENDENTE|A DEFINIR|A VERIFICAR)[^\]]*\]|\[[^\]]+\]\([^)]+\))/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0]; const k = `${key}-${i++}`;
    if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k} className="rounded bg-surface-2 px-1">{t.slice(1, -1)}</code>);
    else if (t.startsWith('{{')) out.push(<mark key={k} className="rounded bg-warning-bg text-warning px-1">{CLIENT_FIELD[t.slice(2, -2)] ? `[${CLIENT_FIELD[t.slice(2, -2)]}]` : '[dado da contratada a definir]'}</mark>);
    else if (/^\[(PENDENTE|A DEFINIR|A VERIFICAR)/.test(t)) out.push(<mark key={k} className="rounded bg-warning-bg text-warning px-1">{t}</mark>);
    else out.push(t.replace(/^\[([^\]]+)\]\(([^)]+)\)$/, '$1 ($2)'));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Markdown simples: títulos, parágrafos, listas, citação e tabelas. */
export function Markdown({ md }: { md: string }) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const h = l.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length; const t = h[2].trim();
      const cls = lvl === 1 ? 'text-2xl font-semibold mt-2' : lvl === 2 ? 'text-lg font-semibold mt-6 scroll-mt-20' : 'font-semibold mt-4 scroll-mt-20';
      blocks.push(React.createElement(`h${Math.min(lvl + 1, 4)}`, { key: i, id: lvl >= 2 ? slug(t) : undefined, className: cls }, inline(t, `h${i}`)));
      i++; continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={i} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-6 space-y-1`}>{items.map((it, j) => <li key={j}>{inline(it, `l${i}-${j}`)}</li>)}</Tag>);
      continue;
    }
    if (/^\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        if (!/^\|[\s:-]+(\|[\s:-]+)*\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(<div key={i} className="overflow-x-auto"><table className="w-full text-sm border-collapse">
        <thead><tr>{head.map((c, j) => <th key={j} className="text-left border-b border-line p-2">{inline(c, `th${i}-${j}`)}</th>)}</tr></thead>
        <tbody>{body.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} className="border-b border-line p-2 align-top">{inline(c, `td${i}-${j}-${k}`)}</td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    if (l.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={i} className="border-l-4 border-line pl-3 text-muted">{inline(q.join(' '), `q${i}`)}</blockquote>);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s|\||>)/.test(lines[i])) p.push(lines[i++]);
    blocks.push(<p key={i} className="leading-relaxed">{inline(p.join(' '), `p${i}`)}</p>);
  }
  return <div className="space-y-3 text-[15px] text-text">{blocks}</div>;
}
