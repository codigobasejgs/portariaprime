import React, { useCallback, useEffect, useState } from 'react';
import { api, rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { toCsv, download } from '../../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Spinner, toast, useAction } from '../../components/ui';
import { useSensitive } from '../../components/Reauth';

type AuditData = {
  porters: { user_id: string; membership_id: string; name: string; document: string | null; status: string; enrolled: boolean }[];
  attempts: { id: string; user_id: string | null; full_name: string | null; method: string; result: string; distance: number | null; created_at: string; has_photo: boolean }[];
  shifts: { id: string; user_id: string; full_name: string | null; started_at: string; expires_at: string; ended_at: string | null; method: string; status: string }[];
  links: { id: string; expires_at: string; uses: number; max_uses: number; revoked_at: string | null }[];
};

export function PorterAuditPage() {
  const t = useTenant();
  const [data, setData] = useState<AuditData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoTitle, setPhotoTitle] = useState('');
  const [resetTarget, setResetTarget] = useState<{ user_id: string; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const { guard, dialog } = useSensitive('Autorizar recadastro biométrico de porteiro. Confirme sua identidade.');
  const { busy, run } = useAction();
  const load = useCallback(() => rpc<AuditData>('porter_audit', { p_tenant: t.tenant.id }).then(setData).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  if (!t.can('team')) return <Alert tone="danger">Acesso restrito a quem gerencia a equipe.</Alert>;
  if (error) return <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>;
  if (!data) return <Spinner />;

  const viewPhoto = (userId: string, name: string, attemptId?: string) => run(async () => {
    const r = await api<{ url: string }>('/api/team/porter-photo', { tenantId: t.tenant.id, userId, attemptId });
    setPhotoTitle(`${name} — ${attemptId ? 'foto da tentativa' : 'foto de referência'}`);
    setPhotoUrl(r.url);
  });

  const exportAttempts = () => {
    const cols: [string, string][] = [['created_at', 'Data/Hora'], ['full_name', 'Porteiro'], ['method', 'Método'], ['result', 'Resultado'], ['distance', 'Distância']];
    download(`auditoria-portaria-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(data.attempts as any, cols));
  };

  const confirmReset = () => {
    if (!resetTarget || reason.trim().length < 5) return toast.error('Informe o motivo (mínimo 5 caracteres).');
    run(guard(async () => {
      await rpc('porter_reference_reset', { p_tenant: t.tenant.id, p_user: resetTarget.user_id, p_reason: reason.trim() });
      toast.success('Referência anterior apagada. O porteiro tem 24h para cadastrar nova face no login.');
      setResetTarget(null); setReason(''); load();
    }));
  };

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-2xl font-semibold">Auditoria de acesso da portaria</h1>
      <Button variant="secondary" onClick={exportAttempts}>Exportar tentativas (CSV)</Button>
    </div>

    <Card className="space-y-3">
      <h2 className="font-semibold">Porteiros cadastrados</h2>
      <p className="text-xs text-muted">A foto de referência é a primeira captura (imutável). Troca exige autorização registrada do síndico.</p>
      {data.porters.length === 0 ? <Empty title="Nenhum porteiro cadastrado" /> : <ul className="divide-y divide-line text-sm">
        {data.porters.map((p) => <li key={p.user_id} className="py-2 flex flex-wrap items-center justify-between gap-2">
          <span><strong>{p.name}</strong> {p.document && <span className="text-muted">· {p.document}</span>}{' '}
            <Badge tone={p.enrolled ? 'success' : 'neutral'}>{p.enrolled ? 'biometria ativa' : 'sem biometria'}</Badge>
            {p.status !== 'active' && <Badge tone="danger"> {p.status}</Badge>}
          </span>
          <span className="flex gap-2">
            {p.enrolled && <Button variant="ghost" onClick={() => viewPhoto(p.user_id, p.name)}>Ver referência</Button>}
            {p.enrolled && <Button variant="ghost" onClick={() => { setResetTarget(p); setReason(''); }}>Autorizar recadastro</Button>}
          </span>
        </li>)}
      </ul>}
    </Card>

    <Card className="space-y-3">
      <h2 className="font-semibold">Tentativas recentes de acesso</h2>
      <p className="text-xs text-muted">Fotos de login são retidas por 90 dias. Acesso à foto gera registro de auditoria.</p>
      {data.attempts.length === 0 ? <Empty title="Nenhuma tentativa recente" /> : <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left border-b border-line text-muted"><th className="py-2">Data/Hora</th><th>Porteiro</th><th>Método</th><th>Resultado</th><th>Distância</th><th>Foto</th></tr></thead>
        <tbody className="divide-y divide-line">
          {data.attempts.map((a) => <tr key={a.id}>
            <td className="py-2 whitespace-nowrap">{new Date(a.created_at).toLocaleString('pt-BR')}</td>
            <td>{a.full_name || 'Desconhecido'}</td>
            <td><Badge tone={a.method === 'face' ? 'neutral' : 'warning'}>{a.method === 'face' ? 'rosto' : 'sem câmera'}</Badge></td>
            <td><Badge tone={a.result === 'ok' || a.result === 'accepted' ? 'success' : a.result === 'blocked' ? 'danger' : 'warning'}>{a.result}</Badge></td>
            <td>{a.distance != null ? a.distance.toFixed(3) : '—'}</td>
            <td>{a.has_photo && a.user_id ? <button className="underline text-xs" onClick={() => viewPhoto(a.user_id!, a.full_name || 'Porteiro', a.id)}>Ver foto</button> : '—'}</td>
          </tr>)}
        </tbody>
      </table></div>}
    </Card>

    <Card className="space-y-3">
      <h2 className="font-semibold">Turnos de 12 horas</h2>
      {data.shifts.length === 0 ? <Empty title="Nenhum turno registrado" /> : <ul className="divide-y divide-line text-sm">
        {data.shifts.map((s) => <li key={s.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
          <span><strong>{s.full_name || 'Porteiro'}</strong> · Início: {new Date(s.started_at).toLocaleString('pt-BR')} · Expira: {new Date(s.expires_at).toLocaleTimeString('pt-BR')}</span>
          <Badge tone={s.status === 'ativo' ? 'success' : s.status === 'expirado' ? 'danger' : 'neutral'}>{s.status}</Badge>
        </li>)}
      </ul>}
    </Card>

    {photoUrl && <Modal title={photoTitle} onClose={() => setPhotoUrl(null)}>
      <div className="space-y-3 text-center">
        <img src={photoUrl} alt={photoTitle} className="max-h-96 mx-auto rounded-xl border border-line" />
        <p className="text-xs text-muted">Link temporário (60s). Esta visualização foi registrada nos logs de auditoria do condomínio.</p>
        <Button onClick={() => setPhotoUrl(null)}>Fechar</Button>
      </div>
    </Modal>}

    {resetTarget && <Modal title={`Autorizar recadastro — ${resetTarget.name}`} onClose={() => setResetTarget(null)}>
      <div className="space-y-4">
        <Alert tone="warning">A foto e o descritor de referência atuais serão <strong>excluídos permanentemente</strong>. O porteiro terá 24 horas para capturar nova referência no próximo login.</Alert>
        <Field label="Motivo da troca (obrigatório, registrado em auditoria)" hint="Ex.: alteração fisionômica, falha de reconhecimento, troca de documento">
          <Input required minLength={5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Descreva o motivo" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setResetTarget(null)}>Cancelar</Button>
          <Button loading={busy} onClick={confirmReset} disabled={reason.trim().length < 5}>Confirmar e autorizar</Button>
        </div>
      </div>
      {dialog}
    </Modal>}
  </div>;
}
