// Contratos do condomínio (Configurações › Plano e assinatura): situação contratual,
// histórico de aceites/aditivos, PDF, reenvio da cópia e cancelamento com resumo de efeitos.
// Estados separados: contrato aqui; pagamento e assinatura no restante da tela.
import React, { useEffect, useState } from 'react';
import { api, rpc } from '../../lib/api';
import { brl, CYCLE_LABEL, dateTime } from '../../lib/format';
import { navigate } from '../../lib/router';
import { useTenant } from '../../lib/tenant';
import { Alert, Badge, Button, Card, Modal, Spinner, useAction } from '../../components/ui';
import { SignatureRow, type SigRow } from '../../components/SignaturePanel';

const STATE: Record<string, [string, 'success' | 'warning' | 'neutral' | 'danger']> = {
  none: ['Sem contrato aceito', 'neutral'], active: ['Vigente', 'success'], ending: ['Encerramento agendado', 'warning'], ended: ['Encerrado', 'neutral'],
};
const ACC: Record<string, string> = { pending_verification: 'Aguardando assinatura do síndico', active: 'Vigente', superseded: 'Substituído por aditivo', ended: 'Encerrado' };
const COPY: Record<string, string> = { queued: 'Na fila', sending: 'Enviando', accepted: 'Enviada', delivered: 'Entregue', failed: 'Falhou', disabled: 'Envio não configurado' };

export function ContractsCard() {
  const t = useTenant();
  const tz = t.tenant.timezone;
  const [ov, setOv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cancel, setCancel] = useState<any>(null);
  const [ver, setVer] = useState(0);
  const { busy, run } = useAction();

  const [sigs, setSigs] = useState<Record<string, SigRow>>({});
  useEffect(() => {
    let on = true;
    rpc('contract_overview', { p_tenant: t.tenant.id }).then((d) => on && setOv(d)).catch((e) => on && setErr(e.message));
    rpc<SigRow[]>('contract_signature_status', { p_tenant: t.tenant.id }).then((r) => on && setSigs(Object.fromEntries(r.map((s) => [s.acceptance_id, s])))).catch(() => {});
    return () => { on = false; };
  }, [t.tenant.id, ver]);

  if (err) return <Card><Alert tone="warning">{err}</Alert></Card>;
  if (!ov) return <Card><Spinner /></Card>;
  const [label, tone] = STATE[ov.state] || [ov.state, 'neutral'];
  const plan = t.overview?.plan?.code; const cycle = t.overview?.cycle;
  const pdf = (id: string) => run(async () => { location.href = (await api('/api/billing/contract_pdf', { acceptanceId: id })).url; });

  return (
    <Card className="space-y-3" data-tour="assinatura-contrato">
      <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">Contrato</p><Badge tone={tone}>{label}</Badge></div>
      <p className="text-xs text-muted">O contrato é separado do pagamento: aceitar não cobra nada, e pagar não substitui o aceite.</p>
      {ov.state === 'none' && ov.can_manage && <div className="space-y-2">
        <p className="text-sm">Formalize a contratação com o aceite eletrônico do contrato{ov.current_version ? ` (versão ${ov.current_version})` : ''}.</p>
        <Button variant="secondary" onClick={() => navigate(`/contratar?plano=${encodeURIComponent(plan || '')}&ciclo=${encodeURIComponent(cycle || 'monthly')}`)}>Revisar e aceitar o contrato</Button>
      </div>}
      {ov.needs_new_acceptance && <Alert tone="warning">Há uma nova versão do contrato ({ov.current_version}) com mudanças relevantes. Revise e aceite o aditivo.
        {ov.can_manage && <div className="mt-2"><Button variant="secondary" onClick={() => navigate(`/contratar?plano=${encodeURIComponent(plan || '')}&ciclo=${encodeURIComponent(cycle || 'monthly')}`)}>Revisar aditivo</Button></div>}</Alert>}
      {ov.state === 'ending' && <Alert tone="warning">Cancelamento registrado. O acesso completo vai até {dateTime(ov.ends_at, tz)}.</Alert>}
      {ov.acceptances.length > 0 && <ul className="divide-y divide-line text-sm">
        {ov.acceptances.map((a: any) => <li key={a.id} className="py-2 space-y-1">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{a.kind === 'aditivo' ? 'Aditivo' : 'Contrato'} v{a.document_version} · {a.terms?.plan_name} · {CYCLE_LABEL[a.terms?.cycle] || a.terms?.cycle} · {brl(a.terms?.amount_cents || 0)}</span>
            <Badge tone={a.status === 'active' ? 'success' : a.status === 'pending_verification' ? 'warning' : 'neutral'}>{ACC[a.status] || a.status}</Badge>
          </div>
          <p className="text-xs text-muted">Aceito em {dateTime(a.accepted_at, tz)} por {a.representative_name} ({a.representative_email}){sigs[a.id] ? '' : ` · cópia: ${COPY[a.copy_status] || 'não enviada'}`}</p>
          {sigs[a.id] && <SignatureRow s={sigs[a.id]} onChange={() => setVer((v) => v + 1)} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" loading={busy} onClick={() => pdf(a.id)}>Baixar PDF</Button>
            {ov.can_manage && a.email_verified_at && <Button variant="ghost" loading={busy} onClick={() => run(async () => { await api('/api/billing/contract_resend', { acceptanceId: a.id }); setVer((v) => v + 1); }, 'Cópia reenviada (mesmo PDF).')}>Reenviar cópia</Button>}
          </div>
        </li>)}
      </ul>}
      {ov.can_manage && ov.state === 'active' && <div className="pt-2 border-t border-line">
        <Button variant="ghost" loading={busy} onClick={() => run(async () => setCancel(await rpc('contract_cancel_preview', { p_tenant: t.tenant.id })))}>Cancelar contrato e assinatura</Button>
      </div>}
      {cancel && <Modal title="Cancelar contrato e assinatura" onClose={() => setCancel(null)}>
        <div className="space-y-3 text-sm">
          <p>Efeitos do cancelamento{cancel.access_until ? ` (acesso completo até ${dateTime(cancel.access_until, tz)})` : ''}:</p>
          <ul className="list-disc pl-5 space-y-1">{cancel.effects.map((e: string) => <li key={e}>{e}</li>)}</ul>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setCancel(null)}>Voltar</Button>
            <Button variant="danger" loading={busy} onClick={() => run(async () => {
              await rpc('contract_cancel', { p_tenant: t.tenant.id, p_confirm: true, p_reason: null });
              setCancel(null); setVer((v) => v + 1); await t.reload();
            }, 'Cancelamento registrado.')}>Confirmar cancelamento</Button>
          </div>
        </div>
      </Modal>}
    </Card>
  );
}
