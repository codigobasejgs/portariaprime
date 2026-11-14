import React, { useEffect, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { api } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { useSensitive } from '../../../components/Reauth';
import { Alert, Badge, Button, Field, Input, useAction } from '../../../components/ui';

interface St { state: string; qr: string | null; pairingCode: string | null; phone: string | null }
const fmtPhone = (p: string) => p.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');
const LABEL: Record<string, string> = { open: 'Conectado', connecting: 'Aguardando leitura do QR', closed: 'Reconectando', disconnected: 'Não conectado' };

/**
 * WhatsApp do Portaria Prime IA do condomínio (motor Whaileys), separado do WhatsApp dos avisos (Evolution).
 * Pode ser o mesmo chip: a IA só responde aos números autorizados abaixo; os demais (moradores) ficam sem resposta da IA.
 */
export function AssistantConnect() {
  const t = useTenant();
  const [st, setSt] = useState<St | null>(null);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const { guard, dialog } = useSensitive('Conectar ou desconectar o WhatsApp do assistente. Confirme sua identidade.');
  const alive = useRef(true);
  const call = (op: string, body: Record<string, unknown> = {}) => api<St>(`/api/whatsapp/ia-${op}`, { tenantId: t.tenant.id, ...body });

  useEffect(() => {
    alive.current = true;
    call('status').then((s) => { setSt(s); setError(null); }).catch((e) => setError(e.message));
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.tenant.id]);

  // Enquanto aguarda a leitura, o QR muda a cada ~20 s: consulta de novo até conectar (máx. ~3 min).
  const waiting = st?.state === 'connecting' || st?.state === 'closed';
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const id = setInterval(() => {
      if (++n > 36) { clearInterval(id); return; }
      call('status').then((s) => { if (alive.current) setSt(s); }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, t.tenant.id]);

  const connect = (withPhone: boolean) => run(guard(async () => { setSt(await call('connect', withPhone ? { phone } : {})); }));
  const logout = () => {
    if (!confirm('Desconectar o WhatsApp do assistente? A equipe deixa de usar a IA pelo WhatsApp até conectar de novo.')) return;
    run(guard(async () => { setSt(await call('logout')); }), 'WhatsApp do assistente desconectado.');
  };

  return (
    <div className="rounded-xl border border-line p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold flex items-center gap-2"><Smartphone className="w-4 h-4" aria-hidden /> WhatsApp do assistente</p>
        {st && <Badge tone={st.state === 'open' ? 'success' : 'warning'}>{LABEL[st.state] || st.state}</Badge>}
      </div>
      <p className="text-sm text-muted">
        Número que a equipe usa para falar com a IA. É separado do WhatsApp dos avisos aos moradores (Integrações), mas pode ser o mesmo chip:
        a IA só responde aos números autorizados abaixo e fica em silêncio para os demais.
      </p>
      {error && <Alert tone="warning">{error}</Alert>}
      {st?.state === 'open' && st.phone && <p className="text-sm">Conectado: <strong>{fmtPhone(st.phone)}</strong>. A equipe autorizada manda <strong>“oi”</strong> para este número.</p>}
      {st?.state !== 'open' && st?.qr && (
        <div className="space-y-1">
          <img src={st.qr} alt="QR Code para conectar o WhatsApp do assistente" className="w-56 h-56 bg-white p-2 rounded-xl" />
          <p className="text-xs text-muted">No celular: WhatsApp › Aparelhos conectados › Conectar aparelho. O QR se renova sozinho.</p>
        </div>
      )}
      {st?.state !== 'open' && st?.pairingCode && (
        <p className="text-sm">Código de pareamento: <strong className="font-mono tracking-widest">{st.pairingCode}</strong> (WhatsApp › Aparelhos conectados › Conectar com número de telefone).</p>
      )}
      {!error && (st?.state === 'open'
        ? <Button variant="secondary" loading={busy} onClick={logout}>Desconectar</Button>
        : (
          <div className="flex flex-wrap items-end gap-2">
            <Button loading={busy} onClick={() => connect(false)}>Conectar por QR Code</Button>
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); connect(true); }}>
              <Field label="Ou por código (número do chip)"><Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="11 99999-0000" required /></Field>
              <Button type="submit" variant="secondary" loading={busy}>Gerar código</Button>
            </form>
          </div>
        ))}
      {dialog}
    </div>
  );
}
