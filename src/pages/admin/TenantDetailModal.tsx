import React, { useCallback, useEffect, useState } from 'react';
import { friendly, rpc } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Modal, Spinner } from '../../components/ui';
import { PlatformContext, Row, rowActions } from './platform-model';
import { TenantModules } from './TenantModules';

export default function TenantDetailModal({ tenantId, context, onClose, onAction }: { tenantId: string; context: PlatformContext; onClose: () => void; onAction: (name: string, row: Row) => void }) {
  const [data, setData] = useState<{ tenant: Row; subscription: Row; counts: Row; courtesies: Row[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await rpc<{ tenant: Row; subscription: Row; counts: Row; courtesies: Row[] }>('platform_tenant_detail', { p_tenant: tenantId });
      if (!response?.tenant) throw new Error('Condomínio não encontrado.');
      setData(response);
    } catch (e) { setError(friendly(e)); } finally { setLoading(false); }
  }, [tenantId]);
  useEffect(() => { load(); }, [load, version]);
  return <Modal title={data?.tenant?.name ? `Detalhes · ${data.tenant.name}` : 'Detalhes do condomínio'} onClose={onClose} wide>
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {loading ? <Spinner /> : !data ? null : <>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <div><p className="font-semibold text-lg">{data.tenant.name}</p><p className="font-mono text-xs text-muted">{data.tenant.id} · /{data.tenant.slug}</p></div>
          <Badge tone={data.tenant.status === 'active' ? 'success' : 'danger'}>{data.tenant.status === 'active' ? 'Ativo' : data.tenant.status === 'suspended' ? 'Suspenso' : data.tenant.status}</Badge>
        </div>
        <div className="grid sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-line p-3"><p className="text-muted">Membros cadastrados</p><p className="text-xl font-semibold mt-1">{data.counts?.members ?? 0}</p></div>
          <div className="rounded-xl border border-line p-3"><p className="text-muted">Unidades cadastradas</p><p className="text-xl font-semibold mt-1">{data.counts?.units ?? 0}</p></div>
          <div className="rounded-xl border border-line p-3"><p className="text-muted">Portarias cadastradas</p><p className="text-xl font-semibold mt-1">{data.counts?.concierges ?? 0}</p></div>
        </div>
        <div className="rounded-xl border border-line p-3 space-y-1 text-sm">
          <h3 className="font-semibold">Assinatura atual</h3>
          <p>Situação comercial: <Badge>{data.subscription?.status || 'Sem assinatura'}</Badge></p>
          <p>Fim do período pago: {dateTime(data.subscription?.current_period_end)}</p>
          <p>Fim do teste: {dateTime(data.subscription?.trial_ends_at)}</p>
          {data.subscription?.trial_extended_reason && <p className="text-muted">Motivo da última prorrogação: {data.subscription.trial_extended_reason}</p>}
        </div>
        <div className="rounded-xl border border-line p-3 space-y-2">
          <div className="flex justify-between items-center"><h3 className="font-semibold text-sm">Cortesias temporárias de acesso</h3>{context.capabilities.includes('courtesy_grant') && <Button variant="secondary" onClick={() => onAction('courtesy_grant', { id: data.tenant.id, name: data.tenant.name })}>Conceder cortesia</Button>}</div>
          {data.courtesies?.length ? <ul className="divide-y divide-line text-sm">{data.courtesies.map(item => <li key={item.id} className="py-2 flex flex-wrap justify-between items-center gap-2"><div><p>{dateTime(item.starts_at)} até {dateTime(item.ends_at)}</p>{item.revoked_at ? <Badge tone="neutral">Revogada em {dateTime(item.revoked_at)}</Badge> : <Badge tone="success">Vigente</Badge>}</div>{!item.revoked_at && context.capabilities.includes('courtesy_revoke') && <Button variant="ghost" onClick={() => onAction('courtesy_revoke', { id: item.id, name: `Cortesia do condomínio ${data.tenant.name}` })}>Revogar</Button>}</li>)}</ul> : <p className="text-xs text-muted">Nenhuma cortesia registrada para este condomínio.</p>}
        </div>
        <TenantModules tenantId={data.tenant.id} canManage={context.capabilities.includes('modules_manage')} />
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {context.capabilities.includes('plans') && <Button variant="secondary" onClick={() => onAction('plan_change', { id: data.tenant.id, name: data.tenant.name, plan_code: data.subscription?.plan_code })}>Trocar plano</Button>}
          {rowActions('tenants', data.tenant, context).map(name => <Button key={name} variant="secondary" onClick={() => onAction(name, data.tenant)}>{name === 'tenant_status' ? 'Alterar situação do condomínio' : name}</Button>)}
          <Button variant="ghost" onClick={() => setVersion(v => v + 1)}>Atualizar</Button>
        </div>
      </>}
    </div>
  </Modal>;
}
