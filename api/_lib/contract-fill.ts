/**
 * Preenchimento do contrato v1.0 a partir do aceite (dados do banco, nunca do navegador).
 * Puro e testável: recebe o JSON de contract_fill_data e devolve o texto preenchido.
 */
import { createHash } from 'node:crypto';

const UNITS = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze',
  'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function below1000(n: number): string {
  if (n === 100) return 'cem';
  const parts: string[] = [];
  if (n >= 100) parts.push(HUNDREDS[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 20) parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? ` e ${UNITS[r % 10]}` : ''));
  else if (r) parts.push(UNITS[r]);
  return parts.join(' e ');
}
function words(n: number): string {
  if (n === 0) return 'zero';
  const mil = Math.floor(n / 1000), rest = n % 1000;
  const parts: string[] = [];
  if (mil) parts.push(mil === 1 ? 'mil' : `${below1000(mil)} mil`);
  if (rest) parts.push(below1000(rest));
  return parts.join(rest && (rest < 100 || rest % 100 === 0) ? ' e ' : ' ');
}
/** Valor por extenso em reais (até R$ 999.999,99). */
export function reaisExtenso(cents: number): string {
  const r = Math.floor(cents / 100), c = cents % 100;
  const real = r ? `${words(r)} ${r === 1 ? 'real' : 'reais'}` : '';
  const cent = c ? `${words(c)} ${c === 1 ? 'centavo' : 'centavos'}` : '';
  return [real, cent].filter(Boolean).join(' e ') || 'zero reais';
}

const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDoc = (d: string) => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;
const fmtPhone = (p: string) => p.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');
const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: tz });
const longDate = (iso: string, tz: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' });
const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };
const CYCLE: Record<string, string> = { monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };

export interface FillData {
  id: string; accepted_at: string; timezone?: string; contractor_name: string; contractor_document: string; contractor_address?: string | null;
  representative_name: string; representative_cpf?: string | null; representative_email: string; representative_phone?: string | null;
  terms: { source?: string; plan_name?: string; plan_code?: string; cycle?: string; amount_cents?: number; limits?: Record<string, any> };
  trial_started_at?: string | null; trial_ends_at?: string | null; document_md: string;
}

export function contractVars(d: FillData): Record<string, string> {
  const tz = d.timezone || 'America/Sao_Paulo';
  const t = d.terms || {};
  const months = MONTHS[t.cycle || 'monthly'] || 1;
  const total = Number(t.amount_cents || 0);
  // ponytail: ciclo trimestral/anual vira "equivalente mensal" + total do ciclo no nome do plano; contrato só fala em mensalidade.
  const monthly = Math.round(total / months);
  const lim = t.limits || {};
  const start = d.trial_started_at || d.accepted_at;
  const end = d.trial_ends_at || new Date(new Date(start).getTime() + 30 * 86400_000).toISOString();
  return {
    CONDOMINIO_NOME: d.contractor_name,
    CONDOMINIO_CNPJ: fmtDoc(d.contractor_document),
    CONDOMINIO_ENDERECO: d.contractor_address || '',
    SINDICO_NOME: d.representative_name,
    SINDICO_CPF: d.representative_cpf ? fmtDoc(d.representative_cpf) : '',
    SINDICO_EMAIL: d.representative_email,
    SINDICO_TELEFONE: d.representative_phone ? fmtPhone(d.representative_phone) : '',
    PLANO_NOME: `${t.plan_name || t.plan_code || ''}${months > 1 ? ` — ciclo ${CYCLE[t.cycle!]}, R$ ${brl(total)} a cada ${months} meses` : ''}`,
    PLANO_VALOR_MENSAL: brl(monthly),
    PLANO_VALOR_EXTENSO: reaisExtenso(monthly) + (months > 1 ? ', equivalente mensal' : ''),
    PLANO_LIMITE_DESCRICAO: [lim.max_units && `até ${lim.max_units} unidades`, lim.max_concierges && `${lim.max_concierges} portaria(s)`].filter(Boolean).join(' e ') || 'conforme plano',
    TAXA_IMPLANTACAO_DESCRICAO: t.source === 'proposal' ? 'Conforme proposta comercial aceita' : 'Isenta',
    DATA_INICIO_TRIAL: day(start, tz),
    DATA_FIM_TRIAL: day(end, tz),
    DIA_VENCIMENTO: String(Number(new Date(end).toLocaleDateString('en-CA', { timeZone: tz }).slice(8, 10))),
    DATA_EXTENSO_CONTRATO: longDate(d.accepted_at, tz),
    AUTENTIQUE_DOCUMENT_ID: 'atribuído pela Autentique no manifesto de assinaturas',
    CONTRACT_SHA256_HASH: 'registrado no manifesto de assinaturas da Autentique',
  };
}

/** Texto preenchido + hash dele. Sobrar {{...}} é erro (contrato incompleto não sai para assinatura). */
export function fillContract(d: FillData): { text: string; sha256: string } {
  const v = contractVars(d);
  const text = d.document_md.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (v[k] ? v[k] : m));
  const left = text.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (left) throw new Error(`Contrato com campos sem dado: ${[...new Set(left)].join(', ')}`);
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}
