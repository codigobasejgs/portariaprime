/** Celular e e-mail: mesmas regras no painel (cadastro, importação) e no servidor (planilha pelo WhatsApp). */
export function phoneE164(v: string): string | null {
  let d = v.replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 11 || d[0] === '0' || Number(d.slice(0, 2)) < 11 || d[2] !== '9') return null;
  return `+55${d}`;
}

export const normEmail = (v: string) => v.trim().toLowerCase();
export const validEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(v));
