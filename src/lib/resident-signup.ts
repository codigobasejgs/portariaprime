// Cadastro do morador: validação e normalização no cliente (o servidor valida tudo de novo).

/** Máscara de celular brasileiro enquanto digita: (11) 98888-7777. */
export function maskPhone(v: string) {
  const d = v.replace(/\D/g, '').replace(/^55(?=\d{11})/, '').slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** Celular → E.164 (+55DD9NNNNNNNN) ou null se inválido. Mesma regra do banco (app.phone_e164). */
export function phoneE164(v: string): string | null {
  let d = v.replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 11 || d[0] === '0' || Number(d.slice(0, 2)) < 11 || d[2] !== '9') return null;
  return `+55${d}`;
}

export const normEmail = (v: string) => v.trim().toLowerCase();
export const validEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(v));
export const fullName = (v: string) => v.trim().replace(/\s+/g, ' ');
export const validFullName = (v: string) => /^\S{2,}(\s+\S+)+$/.test(fullName(v));

export interface SignupForm { name: string; email: string; phone: string; block: string; unit: string; unitFree: string; password: string; password2: string; accepted: boolean }
export type UnitOpt = { block: string | null; label: string };
export type Errors = Partial<Record<keyof SignupForm | 'term', string>>;

/**
 * Erros por campo (vazio = válido). hasBlocks: o condomínio organiza unidades por bloco.
 * account=false: pessoa já logada (sem e-mail/senha no formulário).
 */
export function validate(f: SignupForm, hasBlocks: boolean, units: UnitOpt[], hasTerm: boolean, account = true): Errors {
  const e: Errors = {};
  if (!validFullName(f.name)) e.name = 'Informe nome e sobrenome.';
  if (account && !validEmail(f.email)) e.email = 'Informe um e-mail válido.';
  if (!phoneE164(f.phone)) e.phone = 'Informe o celular com DDD, ex.: (11) 98888-7777.';
  if (hasBlocks && !f.block.trim()) e.block = 'Escolha o bloco ou a torre.';
  if (!f.unit.trim()) e.unit = 'Escolha ou informe a unidade.';
  else if (f.unit === OTHER) { if (!f.unitFree.trim()) e.unitFree = 'Informe a sua unidade.'; }
  else if (units.length && !units.some((u) => (u.block || '') === (hasBlocks ? f.block : '') && u.label === f.unit)) e.unit = 'Escolha uma unidade da lista.';
  if (account && f.password.length < 10) e.password = 'Use pelo menos 10 caracteres.';
  if (account && f.password2 !== f.password) e.password2 = 'As senhas não conferem.';
  if (!hasTerm) e.term = 'Termo de dados indisponível no momento. Tente novamente em instantes.';
  else if (!f.accepted) e.accepted = 'Marque a ciência do termo de tratamento de dados.';
  return e;
}

/** Unidade que vai para o servidor (texto livre quando a pessoa não achou a dela na lista). */
export const unitValue = (f: SignupForm) => (f.unit === OTHER ? f.unitFree : f.unit).trim();

/** Opção "minha unidade não está na lista" (vai para análise da administração, sem criar unidade). */
export const OTHER = '__outra__';

/** Blocos distintos na ordem do cadastro do condomínio. */
export const blocksOf = (units: UnitOpt[]) => [...new Set(units.map((u) => u.block).filter(Boolean) as string[])];
export const unitsOf = (units: UnitOpt[], block: string, hasBlocks: boolean) => units.filter((u) => (hasBlocks ? u.block === block : true));
