import React, { useCallback, useEffect, useState } from 'react';
import { friendly, rpc } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Field, Input, Spinner } from '../../components/ui';

interface Mod { key: string; name: string; phase: string; available: boolean; requires_hardware: boolean; enabled: boolean; explicit: boolean; version: number | null; reason: string | null; updated_at: string | null }

/**
 * Módulos contratados do condomínio (superadmin). Ligar/desligar exige justificativa e fica na trilha imutável.
 * Desligar não apaga dados e não afeta encomendas; módulo sem implementação ("em desenvolvimento") não liga.
 */
export function TenantModules({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const [data, setData] = useState<{ modules: Mod[]; audit: { module: string; enabled: boolean; reason: string; at: string }[] } | null>(null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<{ key: string; name: string; enabled: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => rpc<any>('platform_tenant_modules', { p_tenant: tenantId }).then(setData).catch((e) => setError(friendly(e))), [tenantId]);
  useEffect(() => { void load(); }, [load]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!edit) return;
    setBusy(true); setError('');
    try {
      await rpc('platform_module_set', { p_tenant: tenantId, p_module: edit.key, p_enabled: edit.enabled, p_reason: reason });
      setEdit(null); setReason(''); await load();
    } catch (err) { setError(friendly(err)); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-line p-3 space-y-2">
      <h3 className="font-semibold text-sm">Módulos contratados</h3>
      {error && <Alert tone="danger">{error}</Alert>}
      {!data ? <Spinner /> : (
        <ul className="divide-y divide-line text-sm" aria-label="Módulos do condomínio">
          {data.modules.map((m) => (
            <li key={m.key} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{m.name} <span className="text-xs text-muted font-mono">{m.key}</span></p>
                <p className="text-xs text-muted">{m.phase}{m.requires_hardware ? ' · depende de hardware' : ''}{m.reason ? ` · ${m.reason}` : ''}{m.updated_at ? ` · ${dateTime(m.updated_at)}` : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={m.enabled ? 'success' : m.available ? 'neutral' : 'warning'}>{m.enabled ? 'Ligado' : m.available ? 'Desligado' : 'Em desenvolvimento'}</Badge>
                {canManage && m.key !== 'parcels' && (m.available || m.enabled) && (
                  <Button variant="secondary" onClick={() => { setEdit({ key: m.key, name: m.name, enabled: !m.enabled }); setReason(''); }}>{m.enabled ? 'Desligar' : 'Ligar'}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <form onSubmit={save} className="rounded-xl bg-surface-2 p-3 space-y-2">
          <p className="text-sm font-medium">{edit.enabled ? 'Ligar' : 'Desligar'} {edit.name}</p>
          {!edit.enabled && <p className="text-xs text-muted">Os dados do módulo ficam guardados; nada é apagado. Encomendas não são afetadas.</p>}
          <Field label="Justificativa (fica na auditoria)"><Input value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required placeholder="Ex.: contrato piloto assinado em 18/11" /></Field>
          <div className="flex gap-2"><Button type="submit" loading={busy}>Confirmar</Button><Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button></div>
        </form>
      )}
      {!!data?.audit.length && (
        <details className="text-xs text-muted"><summary className="cursor-pointer">Histórico ({data.audit.length})</summary>
          <ul className="mt-1 space-y-0.5">{data.audit.map((a, i) => <li key={i}>{dateTime(a.at)} · {a.module} → {a.enabled ? 'ligado' : 'desligado'} · {a.reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
