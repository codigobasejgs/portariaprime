import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Upload } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { api, rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { parseCsv, unitName } from '../../lib/format';
import { loadUnits, UnitRow } from '../../lib/packages';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../components/ui';

export function PessoasPage() {
  const t = useTenant();
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [members, setMembers] = useState<any[] | null>(null);
  const [invites, setInvites] = useState<any[]>([]);
  const [invite, setInvite] = useState<{ role: string; unitId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState('');
  const { busy, run } = useAction();
  const canTeam = t.can('team');
  const canApprove = t.can('approve');

  const load = useCallback(async () => {
    try {
      const [u, m, { data: inv }] = await Promise.all([
        loadUnits(t.tenant.id),
        canTeam || canApprove ? rpc('list_members', { p_tenant: t.tenant.id }) : Promise.resolve([]),
        supabase.from('invitations').select('id, email, role, unit_id, expires_at, accepted_at, revoked_at').eq('tenant_id', t.tenant.id)
          .is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false }).limit(200),
      ]);
      setUnits(u);
      setMembers(m);
      setInvites(inv || []);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, [t.tenant.id, canTeam, canApprove]);
  useEffect(() => { load(); }, [load]);

  const addUnit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    await run(async () => {
      const { error } = await supabase.from('units').insert({ tenant_id: t.tenant.id, block: String(f.get('block') || '').trim() || null, label: String(f.get('label')).trim() });
      if (error) throw new Error(/duplicate|unique/.test(error.message) ? 'Unidade já cadastrada.' : error.message.replace(/^.*?:\s*/, ''));
      form.reset();
      await load();
    }, 'Unidade cadastrada.');
  };

  const toggleUnit = (u: UnitRow) => run(async () => {
    const { error } = await supabase.from('units').update({ active: !u.active }).eq('id', u.id);
    if (error) throw new Error(error.message);
    await load();
  });

  const unitsById = Object.fromEntries((units || []).map((u) => [u.id, u]));
  const shown = (units || []).filter((u) => `${u.block || ''} ${u.label}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Unidades e pessoas</h1>
      {t.link.role === 'admin' && (
        <Card className="space-y-3">
          <div className="flex flex-wrap justify-between gap-2 items-center">
            <p className="font-semibold">Unidades ({units?.filter((u) => u.active).length ?? '…'} ativas{t.overview?.entitlements ? ` de ${t.overview.entitlements.max_units} no plano` : ''})</p>
            <Button variant="secondary" onClick={() => setImporting(true)}><Upload className="w-4 h-4" /> Importar CSV</Button>
          </div>
          <form onSubmit={addUnit} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <Field label="Bloco/Torre (opcional)"><Input name="block" maxLength={30} /></Field>
            <Field label="Unidade"><Input name="label" required maxLength={30} placeholder="101A, Casa 12…" /></Field>
            <Button type="submit" loading={busy}>Adicionar</Button>
          </form>
          <Input aria-label="Filtrar unidades" placeholder="Filtrar" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {!units ? <Spinner /> : shown.length === 0 ? <Empty title="Nenhuma unidade" /> : (
            <ul className="divide-y divide-line max-h-96 overflow-y-auto">
              {shown.map((u) => (
                <li key={u.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                  <span className={u.active ? '' : 'text-muted line-through'}>{unitName(u.block, u.label)}</span>
                  <span className="flex gap-2">
                    {canApprove && u.active && <Button variant="ghost" onClick={() => setInvite({ role: 'morador', unitId: u.id })}>Convidar morador</Button>}
                    <Button variant="ghost" onClick={() => toggleUnit(u)}>{u.active ? 'Desativar' : 'Reativar'}</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {(canTeam || canApprove) && (
        <Card className="space-y-3">
          <div className="flex flex-wrap justify-between gap-2 items-center">
            <p className="font-semibold">Pessoas com acesso</p>
            {canTeam && <Button variant="secondary" onClick={() => setInvite({ role: 'porteiro' })}>Convidar equipe</Button>}
          </div>
          {!members ? <Spinner /> : (
            <ul className="divide-y divide-line">
              {members.map((m) => (
                <li key={m.membership_id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <strong>{m.full_name || m.email}</strong> <span className="text-muted">{m.email}</span>{' '}
                    <Badge tone={m.role === 'admin' ? 'accent' : 'neutral'}>{m.role}</Badge>{' '}
                    {m.status !== 'active' && <Badge tone="danger">revogado</Badge>}
                    {m.units?.length > 0 && <span className="text-muted"> · {m.units.filter((x: any) => x.status === 'active').map((x: any) => unitName(x.block, x.label)).join(', ')}</span>}
                  </span>
                  {((m.role === 'morador' && canApprove) || (m.role !== 'morador' && canTeam)) && (
                    <Button variant="ghost" onClick={() => run(async () => { await rpc('set_membership_status', { p_membership: m.membership_id, p_status: m.status === 'active' ? 'revoked' : 'active' }); await load(); }, 'Acesso atualizado.')}>
                      {m.status === 'active' ? 'Revogar acesso' : 'Reativar'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {invites.length > 0 && (
            <>
              <p className="font-semibold pt-2">Convites pendentes</p>
              <ul className="divide-y divide-line">
                {invites.map((i) => (
                  <li key={i.id} className="py-2 flex justify-between gap-2 text-sm">
                    <span>{i.email} · {i.role}{i.unit_id && unitsById[i.unit_id] ? ` · ${unitName(unitsById[i.unit_id].block, unitsById[i.unit_id].label)}` : ''} · expira {new Date(i.expires_at).toLocaleDateString('pt-BR')}</span>
                    <Button variant="ghost" onClick={() => run(async () => { await rpc('revoke_invitation', { p_invitation: i.id }); await load(); }, 'Convite revogado.')}>Revogar</Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
      {invite && <InviteModal {...invite} units={units || []} onClose={() => setInvite(null)} onDone={() => { setInvite(null); load(); }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
    </div>
  );
}

function InviteModal({ role: initialRole, unitId, units, onClose, onDone }: { role: string; unitId?: string; units: UnitRow[]; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(initialRole);
  const [perms, setPerms] = useState<string[]>(['team', 'approve', 'settings']);
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();
  const unit = units.find((u) => u.id === unitId);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/invitations/send', { tenantId: t.tenant.id, email, role, unitId: role === 'morador' ? unitId : null, permissions: role === 'admin' ? perms : [] });
      if (r.manualLink) setLink(r.manualLink);
      else { toast.success('Convite enviado por e-mail.'); onDone(); }
    });
  };
  return (
    <Modal title={role === 'morador' ? `Convidar morador — ${unitName(unit?.block, unit?.label)}` : 'Convidar equipe'} onClose={link ? onDone : onClose}>
      {link ? (
        <div className="space-y-3">
          <Alert tone="warning">O convite foi criado, mas o e-mail não pôde ser enviado (serviço de e-mail não configurado ou indisponível). Envie este link à pessoa por um canal seguro:</Alert>
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(link); toast.success('Link copiado.'); }}><Copy className="w-4 h-4" /> Copiar link</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-mail da pessoa" hint="O convite só funciona com este e-mail e vale 7 dias."><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {initialRole !== 'morador' && (
            <Field label="Papel">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="porteiro">Porteiro — recebe e entrega encomendas</option>
                <option value="admin">Administrador — síndico/gestão</option>
              </Select>
            </Field>
          )}
          {role === 'admin' && (
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium mb-1">Permissões do administrador</legend>
              {[['team', 'Gerenciar equipe'], ['approve', 'Aprovar moradores'], ['settings', 'Configurações e marca'], ['billing', 'Assinatura e pagamentos']].map(([k, l]) => (
                <label key={k} className="flex gap-2 items-center"><input type="checkbox" checked={perms.includes(k)} onChange={(e) => setPerms(e.target.checked ? [...perms, k] : perms.filter((x) => x !== k))} /> {l}</label>
              ))}
            </fieldset>
          )}
          <Button type="submit" loading={busy} className="w-full">Enviar convite</Button>
        </form>
      )}
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [rows, setRows] = useState<{ block: string; label: string }[] | null>(null);
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const onFile = async (f: File) => {
    if (f.size > 1024 * 1024) return toast.error('Arquivo muito grande (máx. 1 MB).');
    const parsed = parseCsv(await f.text());
    const header = parsed[0]?.map((h) => h.toLowerCase());
    const hasHeader = header?.some((h) => /bloco|torre|unidade|apto/.test(h));
    const data = (hasHeader ? parsed.slice(1) : parsed).map((r) => (r.length === 1 ? { block: '', label: r[0] } : { block: r[0], label: r[1] }));
    setRows(data);
    const r = await run(() => rpc('import_units', { p_tenant: t.tenant.id, p_rows: data, p_dry_run: true }));
    setResult(r);
  };
  const confirm = () => run(async () => {
    const r = await rpc('import_units', { p_tenant: t.tenant.id, p_rows: rows, p_dry_run: false });
    toast.success(`${r.written} unidade(s) importada(s).`);
    onDone();
  });
  return (
    <Modal title="Importar unidades (CSV)" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">Colunas: <code>bloco;unidade</code> (bloco pode ficar vazio). Ex.: <code>A;101</code>, <code>;Casa 12</code>. Nada é gravado antes da prévia sem erros.</p>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        {busy && <Spinner label="Validando…" />}
        {result && (
          <>
            <Alert tone={result.errors.length ? 'warning' : 'success'}>{result.valid} linha(s) válida(s); {result.errors.length} com erro.</Alert>
            {result.errors.length > 0 && (
              <ul className="max-h-48 overflow-y-auto text-danger">{result.errors.map((e: any) => <li key={e.line}>Linha {e.line}: {e.error}</li>)}</ul>
            )}
            <Button disabled={result.errors.length > 0 || result.valid === 0} loading={busy} onClick={confirm} className="w-full">Gravar {result.valid} unidade(s)</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
