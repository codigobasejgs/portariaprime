import React, { useEffect, useRef, useState } from 'react';
import { rpc } from '../lib/api';
import { useSession } from '../lib/session';
import { useRefreshWhileVisible, useTenant } from '../lib/tenant';
import { navigate } from '../lib/router';
import { Button } from './ui';

export const SHIFT_ENDED = 'Turno de 12h encerrado. Faça o login com verificação facial do porteiro do próximo turno para continuar.';
type Shift = { enrolled: boolean; server_now: string; shift: { expires_at: string; ended_at: string | null } | null };
const pad = (n: number) => String(n).padStart(2, '0');

/** Contagem do turno (só porteiro com cadastro biométrico). Expirou: aviso fixo, logout e volta ao login facial. Legados e síndico: nada. */
export function ShiftCountdown() {
  const t = useTenant();
  const { signOut } = useSession();
  const porter = t.link.role === 'porteiro';
  const [s, setS] = useState<Shift | null>(null);
  const offset = useRef(0);
  const [now, setNow] = useState(Date.now());
  const [ended, setEnded] = useState(false);
  const load = () => { if (porter) rpc<Shift>('porter_my_shift', { p_tenant: t.tenant.id }).then((r) => { offset.current = new Date(r.server_now).getTime() - Date.now(); setS(r); }).catch(() => {}); };
  useEffect(load, [porter, t.tenant.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useRefreshWhileVisible(load, 60000);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  const remaining = s?.shift && !s.shift.ended_at ? new Date(s.shift.expires_at).getTime() - (now + offset.current) : 0;
  const expired = !!s?.enrolled && remaining <= 0;
  useEffect(() => { if (expired && !ended) { setEnded(true); void signOut(); } }, [expired, ended, signOut]);
  if (!porter || !s?.enrolled) return null;
  if (expired) return <div role="alertdialog" aria-modal="true" aria-label="Turno encerrado" className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4">
    <div className="bg-surface rounded-2xl p-6 max-w-sm space-y-4 text-center">
      <p className="font-semibold">{s.shift ? SHIFT_ENDED : 'Entre pelo login da portaria com verificação facial para iniciar o turno.'}</p>
      <Button className="w-full" onClick={() => navigate(`/c/${t.tenant.slug}/equipe/entrar`, true)}>Ir para o login da portaria</Button>
    </div>
  </div>;
  const h = Math.floor(remaining / 3600000), m = Math.floor(remaining / 60000) % 60, sec = Math.floor(remaining / 1000) % 60;
  return <span className={`text-xs tabular-nums whitespace-nowrap px-1 ${remaining < 30 * 60000 ? 'text-danger font-semibold' : 'text-muted'}`} title="Tempo restante do turno de 12h" aria-live="off">Turno {pad(h)}:{pad(m)}:{pad(sec)}</span>;
}
