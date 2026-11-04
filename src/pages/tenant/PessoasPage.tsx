import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, MoreVertical, Plus, Upload } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { api, rpc } from '../../lib/api';
import { useRealtime, useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { maskPhone } from '../../lib/resident-signup';
import { navigate, onLink } from '../../lib/router';
import { parseCsv, unitName } from '../../lib/format';
import { blockNames } from '../../lib/units-generate';
import { loadUnits, UnitRow } from '../../lib/packages';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../components/ui';

type Tab = 'unidades' | 'moradores' | 'solicitacoes';
const PAGE = 50;

/** Unidades e moradores: abas Unidades, Moradores e Solicitações (equipe fica em Configurações). */
export function PessoasPage({ tab }: { tab: string | null }) {
  const t = useTenant();
  const canTeam = t.can('team');
  const canApprove = t.can('approve');
  const isAdmin = t.link.role === 'admin';
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [members, setMembers] = useState<any[] | null>(null);
  const [invites, setInvites] = useState<any[]>([]);
  const [pending, setPending] = useState(0);
  const [invite, setInvite] = useState<{ role: string; unitId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, m, { data: inv }, req] = await Promise.all([
        loadUnits(t.tenant.id),
        canTeam || canApprove ? rpc<any[]>('list_members', { p_tenant: t.tenant.id }) : Promise.resolve([]),
        supabase.from('invitations').select('id, email, role, unit_id, expires_at').eq('tenant_id', t.tenant.id).eq('role', 'morador')
          .is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false }).limit(200),
        canApprove ? rpc<any[]>('list_access_requests', { p_tenant: t.tenant.id, p_status: 'pending' }).catch(() => []) : Promise.resolve([]),
      ]);
      setUnits(u);
      setMembers(m);
      setInvites(inv || []);
      setPending((req || []).length);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, [t.tenant.id, canTeam, canApprove]);
  useEffect(() => { load(); }, [load]);

  const tabs: [Tab, string][] = [['unidades', 'Unidades'], ['moradores', 'Moradores']];
  if (canApprove) tabs.push(['solicitacoes', `Solicitações${pending ? ` (${pending})` : ''}`]);
  const valid = tabs.map(([id]) => id);
  const current: Tab = valid.includes(tab as Tab) ? (tab as Tab) : pending ? 'solicitacoes' : 'unidades';
  const go = (id: Tab) => navigate(`/c/${t.tenant.slug}/pessoas?aba=${id}`, true);
  const unitsById = useMemo(() => Object.fromEntries((units || []).map((u) => [u.id, u])), [units]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-semibold">Unidades e moradores</h1>
        {canTeam && (
          <a href={`/c/${t.tenant.slug}/configuracoes?m=equipe`} onClick={onLink} className="text-sm text-muted hover:text-text underline min-h-11 inline-flex items-center">
            Equipe da portaria e administradores › Configurações
          </a>
        )}
      </div>
      <div role="tablist" aria-label="Seções" className="flex gap-1 border-b border-line overflow-x-auto">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={current === id} onClick={() => go(id)}
            className={`min-h-11 px-4 -mb-px border-b-2 text-sm font-medium whitespace-nowrap ${current === id ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text'}`}>{label}</button>
        ))}
      </div>
      {!units ? <Spinner /> : (
        <>
          {current === 'unidades' && <UnitsTab units={units} isAdmin={isAdmin} canApprove={canApprove} onAdd={() => setAdding(true)} onImport={() => setImporting(true)}
            onInvite={(id) => setInvite({ role: 'morador', unitId: id })} onChanged={load} />}
          {current === 'moradores' && <ResidentsTab members={members} invites={invites} unitsById={unitsById} canApprove={canApprove} onChanged={load} />}
          {current === 'solicitacoes' && <AccessRequests units={units} onDecided={load} />}
        </>
      )}
      {adding && <NewUnitModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {invite && <InviteModal {...invite} units={units || []} onClose={() => setInvite(null)} onDone={() => { setInvite(null); load(); }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
    </div>
  );
}

/** Menu de ações da linha (Escape ou clique fora fecha). */
function RowMenu({ label, items }: { label: string; items: { label: string; danger?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <button className="rounded-lg hover:bg-surface-2 min-h-11 min-w-11 grid place-items-center" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((v) => !v)}>
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-60 rounded-xl border border-line bg-surface shadow-lg py-1">
          {items.map((i) => (
            <button key={i.label} role="menuitem" className={`w-full text-left px-3 min-h-11 text-sm hover:bg-surface-2 ${i.danger ? 'text-danger' : ''}`} onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function UnitsTab({ units, isAdmin, canApprove, onAdd, onImport, onInvite, onChanged }: {
  units: UnitRow[]; isAdmin: boolean; canApprove: boolean; onAdd: () => void; onImport: () => void; onInvite: (id: string) => void; onChanged: () => void;
}) {
  const t = useTenant();
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [generating, setGenerating] = useState(false);
  const [blockFilter, setBlockFilter] = useState('');
  const { run } = useAction();
  const active = units.filter((u) => u.active).length;
  const blocks = [...new Set(units.map((u) => u.block).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  const max = (t.overview as any)?.entitlements?.max_units;
  const needle = q.trim().toLowerCase();
  const shown = units.filter((u) => (!blockFilter || u.block === blockFilter) && `${u.block || ''} ${u.label}`.toLowerCase().includes(needle));
  const toggle = (u: UnitRow) => {
    const name = unitName(u.block, u.label);
    const msg = u.active
      ? `Desativar ${name}? Ela deixa de aparecer no recebimento de encomendas e libera vaga no plano. Moradores e histórico são mantidos.`
      : `Reativar ${name}? Ela volta a aparecer no recebimento e conta no limite do plano.`;
    if (!confirm(msg)) return;
    run(async () => {
      const { error } = await supabase.from('units').update({ active: !u.active }).eq('id', u.id);
      if (error) throw new Error(/limit|limite/i.test(error.message) ? 'Limite de unidades do plano atingido.' : error.message);
      onChanged();
    }, u.active ? 'Unidade desativada.' : 'Unidade reativada.');
  };
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap justify-between gap-2 items-center">
        <p className="text-sm"><strong>{active}</strong> unidade(s) ativa(s){max ? <span className="text-muted"> de {max} no plano</span> : null}</p>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setGenerating(true)}><Plus className="w-4 h-4" /> Montar blocos e apartamentos</Button>
            <Button variant="secondary" onClick={onAdd} data-tour="unidades-form">Nova unidade</Button>
            <Button variant="secondary" onClick={onImport} data-tour="unidades-importar"><Upload className="w-4 h-4" /> Importar CSV</Button>
          </div>
        )}
      </div>
      {blocks.length > 0 && <div className="flex flex-wrap gap-1" role="group" aria-label="Filtrar por bloco">
        {['', ...blocks].map((b) => <button key={b || 'todos'} aria-pressed={blockFilter === b} onClick={() => { setBlockFilter(b); setLimit(PAGE); }}
          className={`min-h-9 px-3 rounded-full text-sm border ${blockFilter === b ? 'bg-primary text-primary-fg border-primary' : 'border-line hover:bg-surface-2'}`}>
          {b ? `Bloco ${b}` : 'Todos'} <span className="opacity-70">{units.filter((u) => !b || u.block === b).length}</span></button>)}
      </div>}
      <Input aria-label="Buscar unidade" placeholder="Buscar por bloco ou unidade" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
      {shown.length === 0
        ? <Empty title={units.length ? 'Nenhuma unidade encontrada' : 'Nenhuma unidade cadastrada'}>{units.length ? null : 'Use “Nova unidade” ou importe uma planilha.'}</Empty>
        : (
          <ul className="divide-y divide-line" data-tour="unidades-lista">
            {shown.slice(0, limit).map((u) => (
              <li key={u.id} className="py-1 flex items-center justify-between gap-2 text-sm">
                <span className={u.active ? '' : 'text-muted line-through'}>{unitName(u.block, u.label)}</span>
                {isAdmin && <RowMenu label={`Ações de ${unitName(u.block, u.label)}`} items={[
                  ...(canApprove && u.active ? [{ label: 'Convidar morador (opcional)', onClick: () => onInvite(u.id) }] : []),
                  { label: u.active ? 'Desativar unidade' : 'Reativar unidade', danger: u.active, onClick: () => toggle(u) },
                ]} />}
              </li>
            ))}
          </ul>
        )}
      {shown.length > limit && <Button variant="ghost" onClick={() => setLimit(limit + PAGE)}>Mostrar mais ({shown.length - limit} restantes)</Button>}
      {generating && <GenerateUnitsModal onClose={() => setGenerating(false)} onDone={() => { setGenerating(false); onChanged(); }} />}
    </Card>
  );
}

function GenerateUnitsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [style, setStyle] = useState<'numero' | 'letra' | 'nome' | 'sem'>('letra');
  const [count, setCount] = useState(2);
  const [names, setNames] = useState('');
  const [mode, setMode] = useState<'floors' | 'range'>('floors');
  const [s, setS] = useState({ floor_from: '1', floor_to: '10', per_floor: '4', from: '1', to: '40', prefix: '' });
  const [preview, setPreview] = useState<any>(null);
  const { busy, run } = useAction();
  const blocks = blockNames(style, count, names);
  const spec = () => ({ mode, blocks, ...(mode === 'floors' ? { floor_from: s.floor_from, floor_to: s.floor_to, per_floor: s.per_floor } : { from: s.from, to: s.to }), prefix: s.prefix });
  const total = blocks.length * (mode === 'floors'
    ? Math.max(0, (+s.floor_to - +s.floor_from + 1)) * Math.max(0, +s.per_floor)
    : Math.max(0, +s.to - +s.from + 1));
  const check = () => run(async () => setPreview(await rpc('units_generate', { p_tenant: t.tenant.id, p_spec: spec(), p_dry_run: true })));
  const save = () => run(async () => {
    const r = await rpc<any>('units_generate', { p_tenant: t.tenant.id, p_spec: spec(), p_dry_run: false });
    if (r.errors?.length) { setPreview(r); throw new Error('Nada foi gravado: corrija os itens indicados.'); }
    onDone();
  }, 'Unidades cadastradas.');
  const field = (k: keyof typeof s, label: string, w = 'w-24') => <Field label={label}>
    <Input type={k === 'prefix' ? 'text' : 'number'} inputMode={k === 'prefix' ? 'text' : 'numeric'} className={w} min={0} value={s[k]} maxLength={10}
      onChange={(e) => { setS({ ...s, [k]: e.target.value }); setPreview(null); }} /></Field>;
  return (
    <Modal title="Montar blocos e apartamentos" onClose={onClose} wide>
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">1. Como se chamam os blocos?</legend>
          <div className="flex flex-wrap gap-2">{([['letra', 'Por letra (A, B…)'], ['numero', 'Por número (1, 2…)'], ['nome', 'Cada um com um nome'], ['sem', 'Sem blocos']] as const).map(([k, l]) =>
            <label key={k} className={`min-h-10 px-3 rounded-xl border text-sm inline-flex items-center gap-2 cursor-pointer ${style === k ? 'border-primary bg-surface-2' : 'border-line'}`}>
              <input type="radio" name="style" checked={style === k} onChange={() => { setStyle(k); setPreview(null); }} />{l}</label>)}</div>
          {(style === 'letra' || style === 'numero') && <Field label="Quantos blocos?"><Input type="number" className="w-24" min={1} max={60} value={count} onChange={(e) => { setCount(+e.target.value || 1); setPreview(null); }} /></Field>}
          {style === 'nome' && <Field label="Nomes dos blocos" hint="Um por linha ou separados por vírgula. Ex.: Ipê, Jacarandá, Manacá">
            <textarea className="w-full min-h-20 rounded-xl border border-line bg-surface px-3 py-2 text-sm" value={names} onChange={(e) => { setNames(e.target.value); setPreview(null); }} /></Field>}
          {style !== 'sem' && <p className="text-xs text-muted">Blocos: {blocks.join(', ') || '—'}</p>}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">2. Como são os apartamentos? (iguais em todos os blocos)</legend>
          <div className="flex flex-wrap gap-2">{([['floors', 'Por andar (101, 102… 201…)'], ['range', 'Sequência (1, 2, 3… ou Casa 1…)']] as const).map(([k, l]) =>
            <label key={k} className={`min-h-10 px-3 rounded-xl border text-sm inline-flex items-center gap-2 cursor-pointer ${mode === k ? 'border-primary bg-surface-2' : 'border-line'}`}>
              <input type="radio" name="mode" checked={mode === k} onChange={() => { setMode(k); setPreview(null); }} />{l}</label>)}</div>
          <div className="flex flex-wrap gap-3 items-end">
            {mode === 'floors' ? <>{field('floor_from', 'Do andar')}{field('floor_to', 'até o andar')}{field('per_floor', 'Aptos por andar')}</>
              : <>{field('from', 'Do número')}{field('to', 'até')}{field('prefix', 'Prefixo (opcional)', 'w-32')}</>}
          </div>
          {mode === 'floors' && <p className="text-xs text-muted">Numeração: andar × 100 + posição. Ex.: 1º andar com 4 aptos = 101 a 104; 10º andar = 1001 a 1004.</p>}
        </fieldset>
        <p className="text-sm">Serão criadas <strong>{total.toLocaleString('pt-BR')}</strong> unidade(s){blocks.length > 1 ? ` em ${blocks.length} blocos` : ''}.</p>
        {total > 2000 && <Alert tone="warning">O máximo por vez é 2.000 unidades. Monte em partes (por exemplo, alguns blocos de cada vez).</Alert>}
        {preview && <div className="space-y-2">
          {preview.errors?.length > 0
            ? <Alert tone="danger">{preview.errors.length} unidade(s) com problema (ex.: já cadastradas). Nada será gravado enquanto houver erro.<ul className="mt-1 text-xs">{preview.errors.slice(0, 8).map((e: any) => <li key={e.line}>Item {e.line}: {e.error}</li>)}</ul></Alert>
            : <Alert tone="success">Conferido: {preview.valid} unidade(s) prontas para cadastrar.</Alert>}
          <div className="max-h-40 overflow-y-auto rounded-xl bg-surface-2 p-3 text-xs flex flex-wrap gap-1">
            {(preview.preview || []).map((u: any, i: number) => <span key={i} className="px-2 py-0.5 rounded-full bg-surface border border-line">{unitName(u.block, u.label)}</span>)}
            {preview.count > 60 && <span className="text-muted">… e mais {preview.count - 60}</span>}
          </div>
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy} disabled={!blocks.length || total < 1 || total > 2000} onClick={check}>Ver as unidades</Button>
          <Button loading={busy} disabled={!preview || preview.errors?.length > 0 || preview.valid < 1} onClick={save}>Está certo, cadastrar</Button>
        </div>
      </div>
    </Modal>
  );
}

function NewUnitModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [block, setBlock] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    run(async () => {
      const { error } = await supabase.from('units').insert({ tenant_id: t.tenant.id, block: block.trim() || null, label: label.trim() });
      if (error) {
        const msg = /duplicate|unique/.test(error.message) ? 'Unidade já cadastrada.' : error.message.replace(/^.*?:\s*/, '');
        setError(msg);
        throw new Error(msg);
      }
      onDone();
    }, 'Unidade cadastrada.');
  };
  return (
    <Modal title="Nova unidade" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Bloco/Torre (opcional)"><Input value={block} maxLength={30} onChange={(e) => setBlock(e.target.value)} /></Field>
        <Field label="Unidade" error={error}><Input required maxLength={30} placeholder="101A, Casa 12…" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Button type="submit" loading={busy} className="w-full">Adicionar unidade</Button>
      </form>
    </Modal>
  );
}

function ResidentsTab({ members, invites, unitsById, canApprove, onChanged }: {
  members: any[] | null; invites: any[]; unitsById: Record<string, UnitRow>; canApprove: boolean; onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const { run } = useAction();
  if (!members) return <Spinner />;
  const residents = members.filter((m) => m.role === 'morador');
  const unitsOf = (m: any) => (m.units || []).filter((x: any) => x.status === 'active').map((x: any) => unitName(x.block, x.label)).join(', ');
  const needle = q.trim().toLowerCase();
  const shown = residents.filter((m) => `${m.full_name || ''} ${m.email} ${unitsOf(m)}`.toLowerCase().includes(needle));
  const toggle = (m: any) => {
    const who = m.full_name || m.email;
    const msg = m.status === 'active'
      ? `Revogar o acesso de ${who}? A pessoa deixa na hora de ver as encomendas e de receber avisos da unidade. O histórico é mantido e o acesso pode ser reativado.`
      : `Reativar o acesso de ${who}? A pessoa volta a ver as encomendas e a receber avisos da unidade.`;
    if (!confirm(msg)) return;
    run(async () => {
      await rpc('set_membership_status', { p_membership: m.membership_id, p_status: m.status === 'active' ? 'revoked' : 'active' });
      onChanged();
    }, 'Acesso atualizado.');
  };
  return (
    <div className="space-y-4">
      <Card className="space-y-3" data-tour="moradores-lista">
        <p className="text-sm"><strong>{residents.filter((m) => m.status === 'active').length}</strong> morador(es) com acesso ativo</p>
        <Input aria-label="Buscar morador" placeholder="Buscar por nome, e-mail ou unidade" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
        {shown.length === 0
          ? <Empty title={residents.length ? 'Nenhum morador encontrado' : 'Nenhum morador ainda'}>{residents.length ? null : 'Compartilhe o link do portal do condomínio para os moradores pedirem acesso.'}</Empty>
          : (
            <ul className="divide-y divide-line">
              {shown.slice(0, limit).map((m) => {
                const us = unitsOf(m);
                return (
                  <li key={m.membership_id} className="py-2 flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{m.full_name || <span className="text-muted">Sem nome</span>} {m.status !== 'active' && <Badge tone="danger">revogado</Badge>}</p>
                      <p className="text-muted truncate">{m.email} · {us || 'sem unidade ativa'}</p>
                    </div>
                    {canApprove && <RowMenu label={`Ações de ${m.full_name || m.email}`} items={[
                      { label: m.status === 'active' ? 'Revogar acesso' : 'Reativar acesso', danger: m.status === 'active', onClick: () => toggle(m) },
                    ]} />}
                  </li>
                );
              })}
            </ul>
          )}
        {shown.length > limit && <Button variant="ghost" onClick={() => setLimit(limit + PAGE)}>Mostrar mais ({shown.length - limit} restantes)</Button>}
      </Card>
      {invites.length > 0 && (
        <Card className="space-y-2">
          <p className="font-semibold">Convites de morador pendentes ({invites.length})</p>
          <ul className="divide-y divide-line">
            {invites.map((i) => {
              const u = i.unit_id ? unitsById[i.unit_id] : null;
              return (
                <li key={i.id} className="py-2 flex flex-wrap justify-between items-center gap-2 text-sm">
                  <span className="min-w-0 break-all">{i.email}{u ? ` · ${unitName(u.block, u.label)}` : ''} <span className="text-muted">· expira {new Date(i.expires_at).toLocaleDateString('pt-BR')}</span></span>
                  {canApprove && <Button variant="ghost" onClick={() => run(async () => { await rpc('revoke_invitation', { p_invitation: i.id }); onChanged(); }, 'Convite revogado.')}>Revogar</Button>}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
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

/** Solicitações de cadastro feitas pelo portal (sem convite). Aprovar cria o vínculo; recusar exige motivo. */
function AccessRequests({ units, onDecided }: { units: UnitRow[]; onDecided: () => void }) {
  const t = useTenant();
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState<any[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const [incomplete, setIncomplete] = useState<any[]>([]);
  const load = useCallback(() => {
    void rpc<any[]>('access_incomplete_signups', { p_tenant: t.tenant.id }).then((x) => setIncomplete(x || [])).catch(() => setIncomplete([]));
    return rpc<any[]>('list_access_requests', { p_tenant: t.tenant.id, p_status: status || null }).then(setRows).catch(() => setRows([]));
  }, [t.tenant.id, status]);
  useEffect(() => { load(); }, [load]);
  // Pedido novo gera aviso para quem aprova: a fila atualiza sozinha (e ao voltar para a aba).
  useRealtime('notifications', t.tenant.id, load);
  useRefreshWhileVisible(load, 60000);
  const active = units.filter((u) => u.active);
  const decide = (r: any, approve: boolean) => run(async () => {
    const reason = approve ? null : prompt('Motivo da recusa (o morador verá esta mensagem):');
    if (!approve && (!reason || reason.trim().length < 3)) throw new Error('Informe o motivo da recusa.');
    await rpc('decide_access_request', { p_request: r.id, p_approve: approve, p_unit: pick[r.id] || r.unit_id || null, p_reason: reason });
    await load(); onDecided();
    dispatchEvent(new Event('pp:access-requests')); // contador do menu
  }, approve ? 'Cadastro aprovado.' : 'Solicitação recusada.');
  if (!rows) return <Spinner />;
  return (
    <Card className="space-y-3" data-tour="solicitacoes">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <p className="font-semibold">Solicitações de cadastro {status === 'pending' ? `(${rows.length})` : ''}</p>
        <Select aria-label="Filtrar solicitações" value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="pending">Pendentes</option><option value="approved">Aprovadas</option><option value="rejected">Recusadas</option><option value="">Todas</option>
        </Select>
      </div>
      {rows.length === 0 ? <Empty title="Nenhuma solicitação">{status === 'pending' ? 'Moradores pedem acesso pelo link do portal do condomínio. Os pedidos aparecem aqui para aprovação.' : null}</Empty> : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="py-3 space-y-2 text-sm">
              <p><strong>{r.full_name}</strong> <span className="text-muted">{r.email}{r.phone ? ` · ${maskPhone(r.phone)}` : ''}</span>
                {r.email_verified === false && <> <Badge tone="warning">e-mail não confirmado</Badge></>}</p>
              <p>Informou: <strong>{[r.block_text, r.unit_text].filter(Boolean).join(' ')}</strong> · {new Date(r.created_at).toLocaleString('pt-BR')}
                {r.status !== 'pending' && <> · <Badge tone={r.status === 'approved' ? 'success' : 'danger'}>{r.status === 'approved' ? 'aprovada' : 'recusada'}</Badge>{r.reason ? ` ${r.reason}` : ''}</>}</p>
              <p>{r.privacy_version
                ? <Badge tone="success">Termo de dados {r.privacy_version} aceito em {new Date(r.privacy_accepted_at).toLocaleString('pt-BR')}</Badge>
                : <Badge tone="warning">Sem aceite do termo de dados registrado</Badge>}
                {!r.privacy_version && r.status === 'pending' && <span className="block text-xs text-muted mt-1">Pedidos enviados depois da publicação do termo só podem ser aprovados com o aceite. Recusar continua possível.</span>}</p>
              {r.status === 'pending' && (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={r.unit_id ? 'Unidade (encontrada)' : 'Unidade não encontrada: escolha'}>
                    <Select value={pick[r.id] ?? r.unit_id ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                      <option value="">Selecione…</option>
                      {active.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label)}</option>)}
                    </Select>
                  </Field>
                  <Button loading={busy} disabled={!(pick[r.id] || r.unit_id)} onClick={() => decide(r, true)}>Aprovar</Button>
                  <Button variant="ghost" loading={busy} onClick={() => decide(r, false)}>Recusar</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {incomplete.length > 0 && (
        <details className="text-sm rounded-xl bg-surface-2 p-3">
          <summary className="cursor-pointer font-medium">Cadastros não concluídos ({incomplete.length})</summary>
          <p className="mt-2 text-xs text-muted">Contas criadas pelo portal que ainda não confirmaram o e-mail ou não concluíram o envio. O pedido aparece na fila quando o morador entrar — nada é aprovado automaticamente.</p>
          <ul className="mt-2 space-y-1">{incomplete.map((d, i) => <li key={i}>{d.full_name} · {[d.block_text, d.unit_text].filter(Boolean).join(' ')} <span className="text-muted">· {new Date(d.created_at).toLocaleDateString('pt-BR')}</span></li>)}</ul>
        </details>
      )}
    </Card>
  );
}
