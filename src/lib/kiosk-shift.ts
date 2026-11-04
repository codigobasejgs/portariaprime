import { supabase } from './supabase';

/**
 * Turno no quiosque Android. O app nativo entrega um nonce do aparelho no fragmento da URL
 * inicial (#ppk=…); aqui ele é guardado só nesta aba e usado para registrar início/fim de turno
 * do operador logado. Fora do quiosque não há nonce e nada acontece. O servidor resolve aparelho
 * e condomínio pelo nonce e só registra se o operador for equipe ativa daquele condomínio.
 */
const KEY = 'pp_kiosk_shift';

export function captureKioskNonce(): void {
  const m = location.hash.match(/(?:^#|&)ppk=([0-9a-f]{64})/);
  if (!m) return;
  try { sessionStorage.setItem(KEY, m[1]); } catch { /* sem storage */ }
  history.replaceState(history.state, '', location.pathname + location.search);
}

const nonce = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };

export async function kioskShift(event: 'shift.start' | 'shift.end'): Promise<void> {
  const n = nonce();
  if (!n) return;
  try { await supabase.rpc('mdm_shift_event', { p_nonce: n, p_event: event }); } catch { /* auditoria não bloqueia a operação */ }
}

export const isKiosk = () => !!nonce();

/**
 * Aberto pelo app Android do quiosque (WebView marca o user agent; o nonce pode faltar antes do turno).
 * Só ajusta a tela (login da equipe, sem cadastro de morador); permissões continuam no servidor.
 */
export const isKioskApp = () => isKiosk() || (typeof navigator !== 'undefined' && /\bPortariaPrimeKiosk\//.test(navigator.userAgent));

/** Login da equipe no quiosque, voltando para a área de operação pedida (nunca área do morador). */
export function kioskLogin(slug: string, area = '') {
  const staff = /^(portaria|totem-equipe|painel|relatorios|pessoas|configuracoes|avisos|ajuda|comprovante|suporte|aplicativo)$/.test(area);
  return `/entrar?next=${encodeURIComponent(`/c/${slug}/${staff ? area : 'portaria'}`)}&portal=${slug}`;
}
