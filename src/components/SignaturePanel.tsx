// Situação das duas assinaturas (Autentique), botão para assinar, "Já assinei / Atualizar status" e PDF assinado.
import React, { useCallback, useEffect, useState } from 'react';
import { api, rpc } from '../lib/api';
import { dateTime } from '../lib/format';
import { Alert, Badge, Button, Spinner, useAction } from './ui';

export type SigRow = { acceptance_id: string; contract_status: string; contractor_signed_at: string | null; owner_signed_at: string | null;
  fully_signed_at: string | null; rejected_reason: string | null; has_signed_pdf: boolean; sign_url: string | null; sandbox: boolean; last_error: string | null };

export const SIG_LABEL: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  pending_send: ['Preparando envio', 'neutral'], not_configured: ['Assinatura eletrônica em configuração', 'warning'], send_failed: ['Envio falhou', 'danger'],
  awaiting_signatures: ['Aguardando assinaturas', 'warning'], signed_by_contractor: ['Assinado pelo condomínio', 'warning'],
  signed_by_owner: ['Assinado pela Portaria Prime', 'warning'], fully_signed: ['Assinado pelas duas partes', 'success'], rejected: ['Recusado', 'danger'],
};

export function SignatureRow({ s, onChange }: { s: SigRow; onChange?: () => void }) {
  const { busy, run } = useAction();
  const [label, tone] = SIG_LABEL[s.contract_status] || [s.contract_status, 'neutral'];
  const sync = () => run(async () => { await api('/api/billing/contract_sync', { acceptanceId: s.acceptance_id }); onChange?.(); }, 'Status atualizado.');
  const pdf = () => run(async () => { location.href = (await api('/api/billing/contract_signed_pdf', { acceptanceId: s.acceptance_id })).url; });
  const check = (done: string | null, who: string) => <li className="flex gap-2 items-center">
    <span aria-hidden className={`inline-grid place-items-center w-5 h-5 rounded border ${done ? 'bg-success text-white border-success' : 'border-line'}`}>{done ? '✓' : ''}</span>
    <span>{who}{done ? ` — ${dateTime(done)}` : ' — pendente'}</span></li>;
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><Badge tone={tone}>{label}</Badge>{s.sandbox && <Badge tone="neutral">teste (sandbox)</Badge>}</div>
    <ul className="text-sm space-y-1" aria-live="polite">{check(s.contractor_signed_at, 'Assinatura do Condomínio (Síndico)')}{check(s.owner_signed_at, 'Assinatura da Portaria Prime (Contratada)')}</ul>
    {s.rejected_reason && <Alert tone="danger">Recusado: {s.rejected_reason}. Fale com a Portaria Prime para gerar uma nova via.</Alert>}
    {s.last_error && <Alert tone="warning">{s.last_error}</Alert>}
    <div className="flex flex-wrap gap-2">
      {s.sign_url && <a href={s.sign_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl px-4 min-h-11 bg-primary text-primary-fg font-semibold">✍️ Assinar contrato agora na Autentique</a>}
      {s.contract_status !== 'fully_signed' && s.contract_status !== 'rejected' && <Button variant="secondary" loading={busy} onClick={sync}>🔄 Já assinei / Atualizar status</Button>}
      {s.has_signed_pdf && <Button variant="secondary" loading={busy} onClick={pdf}>📄 Baixar contrato assinado (PDF)</Button>}
    </div>
    {s.sign_url && <p className="text-xs text-muted">O link de assinatura também foi enviado ao e-mail do síndico pela Autentique. Abre em nova aba, no site da Autentique.</p>}
  </div>;
}

/** Painel de um aceite (usado logo depois do aceite em /contratar). */
export function SignaturePanel({ acceptanceId, tenantId }: { acceptanceId: string; tenantId: string }) {
  const [row, setRow] = useState<SigRow | null>(null);
  const load = useCallback(() => rpc<SigRow[]>('contract_signature_status', { p_tenant: tenantId })
    .then((r) => setRow(r.find((x) => x.acceptance_id === acceptanceId) || null)).catch(() => setRow(null)), [acceptanceId, tenantId]);
  useEffect(() => { void load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [load]);
  return row ? <SignatureRow s={row} onChange={load} /> : <Spinner />;
}
