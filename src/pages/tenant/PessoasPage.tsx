import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, MoreVertical, Plus, Upload } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { api, rpc } from '../../lib/api';
import { useRealtime, useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { maskPhone, relationLabel } from '../../lib/resident-signup';
import { navigate, onLink } from '../../lib/router';
import { dateTime, parseCsv, unitName } from '../../lib/format';
import { blockNames } from '../../lib/units-generate';
import { loadUnits, UnitRow } from '../../lib/packages';
import { signedUrl } from '../../lib/files';
import { distinctBlocks, naturalCompare, parseUnitQuery, textMatches, unitCode, unitScore } from '../../lib/unit-query';
import { useUnitLabels } from '../../hooks/useUnitLabels';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../components/ui';
import { AccessRequestEditModal, InvitationEditModal, ResidentDeleteModal, ResidentEditModal } from './ResidentManage';
import { UNIDENTIFIED_REASONS } from './portaria/ReceiveForm';
import { ImportResidents } from './ImportResidents';

type Tab = 'unidades' | 'moradores' | 'solicitacoes' | 'nao-identificado' | 'importados';
const PAGE = 50;

/* Busca e filtros (abas Unidades e Moradores) ------------------------------------------------
 * Situação vem do vínculo (list_members): tenant_memberships.status + unit_memberships.status.
 * active+active = Aprovado; pending (ou solicitação pendente da unidade) = Pendente;
 * revoked/rejected (vínculo ou unidade) = Reprovado/Revogado; convite sem aceite = Importado/Convite pendente. */
type PersonStatus = 'active' | 'pending' | 'revoked' | 'invited';
const STATUS_OPTS: [PersonStatus | '', string][] = [['', 'Todos'], ['active', 'Aprovado'], ['pending', 'Pendente'], ['revoked', 'Reprovado/Revogado'], ['invited', 'Importado/Convite pendente']];
const STATUS_BADGE: Record<PersonStatus, ['success' | 'warning' | 'danger' | 'accent', string]> = {
  active: ['success', 'aprovado'], pending: ['warning', 'pendente'], revoked: ['danger', 'revogado'], invited: ['accent', 'convite pendente'],
};
interface Person { key: string; kind: 'member' | 'request' | 'invite'; name: string; email: string | null; phone: string | null; status: PersonStatus; raw: any }
interface Filter { q: string; block: string; status: PersonStatus | '' }
const memberStatus = (m: any): PersonStatus => m.status === 'active' ? 'active' : m.status === 'pending' ? 'pending' : 'revoked';

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]);
  return d;
}

/** Bloco digitado ou escolhido: "1A" ≡ "01A"; enquanto não bate com um bloco existente, vale como prefixo. */
function blockMatcher(blocks: { key: string }[], typed: string) {
  const bc = unitCode(typed);
  if (!bc) return () => true;
  const exact = blocks.some((b) => b.key === bc);
  return (block: string | null) => (exact ? unitCode(block) === bc : unitCode(block).startsWith(bc));
}

function Filters({ f, set, blocks, placeholder, label }: { f: Filter; set: (f: Filter) => void; blocks: { key: string; label: string }[]; placeholder: string; label: string }) {
  const labels = useUnitLabels();
  const id = `blocos-${label.replace(/\W/g, '')}`;
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_10rem_13rem]">
      <Input aria-label={label} placeholder={placeholder} value={f.q} onChange={(e) => set({ ...f, q: e.target.value })} />
      {blocks.length > 0 ? <>
        <Input aria-label={`Filtrar por ${labels.group.toLocaleLowerCase('pt-BR')}`} placeholder={`${labels.group}: todos`} list={id} value={f.block} onChange={(e) => set({ ...f, block: e.target.value })} />
        <datalist id={id}>{blocks.map((b) => <option key={b.key} value={b.label} />)}</datalist>
      </> : <span className="hidden sm:block" />}
      <Select aria-label="Filtrar por situação" value={f.status} onChange={(e) => set({ ...f, status: e.target.value as Filter['status'] })}>
        {STATUS_OPTS.map(([k, l]) => <option key={k || 'todos'} value={k}>{l}</option>)}
      </Select>
    </div>
  );
}

function PersonLine({ p, canApprove }: { p: Person; canApprove: boolean }) {
  const [tone, text] = STATUS_BADGE[p.status];
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <span>{p.name}</span> <Badge tone={tone}>{text}</Badge>
      {canApprove && (p.phone || (p.email && p.email !== p.name)) && <span className="text-muted break-all">· {[p.phone && maskPhone(p.phone), p.email !== p.name && p.email].filter(Boolean).join(' · ')}</span>}
    </span>
  );
}

/** Unidades e moradores: abas Unidades, Moradores e Solicitações (equipe fica em Configurações). */
export function PessoasPage({ tab }: { tab: string | null }) {
  const t = useTenant();
  const canTeam = t.can('team');
  const canApprove = t.can('approve');
  const isAdmin = t.link.role === 'admin';
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [members, setMembers] = useState<any[] | null>(null);
  const [invites, setInvites] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [unidentified, setUnidentified] = useState<any[] | null>(null);
  const [invite, setInvite] = useState<{ role: string; unitId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const pending = requests.length;

  const load = useCallback(async () => {
    try {
      const [u, m, { data: inv }, req, unid] = await Promise.all([
        loadUnits(t.tenant.id),
        canTeam || canApprove ? rpc<any[]>('list_members', { p_tenant: t.tenant.id }) : Promise.resolve([]),
        supabase.from('invitations').select('id, email, role, unit_id, expires_at').eq('tenant_id', t.tenant.id).eq('role', 'morador')
          .is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false }).limit(200),
        canApprove ? rpc<any[]>('list_access_requests', { p_tenant: t.tenant.id, p_status: 'pending' }).catch(() => []) : Promise.resolve([]),
        canApprove ? rpc<any[]>('list_unidentified_packages', { p_tenant: t.tenant.id }).catch(() => []) : Promise.resolve([]),
      ]);
      setUnits(u);
      setMembers(m);
      setInvites(inv || []);
      setRequests(req || []);
      setUnidentified(unid || []);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, [t.tenant.id, canTeam, canApprove]);
  useEffect(() => { load(); }, [load]);

  const tabs: [Tab, string][] = [['unidades', 'Unidades'], ['moradores', 'Moradores']];
  if (canApprove) tabs.push(['solicitacoes', `Solicitações${pending ? ` (${pending})` : ''}`]);
  if (canApprove) tabs.push(['nao-identificado', `Morador não identificado${unidentified?.length ? ` (${unidentified.length})` : ''}`]);
  if (canApprove) tabs.push(['importados', 'Pré-cadastro']);
  const valid = tabs.map(([id]) => id);
  const current: Tab = valid.includes(tab as Tab) ? (tab as Tab) : pending ? 'solicitacoes' : 'unidades';
  const go = (id: Tab) => navigate(`/c/${t.tenant.slug}/pessoas?aba=${id}`, true);
  const unitsById = useMemo(() => Object.fromEntries((units || []).map((u) => [u.id, u])), [units]);
  // Pessoas por unidade: vínculos, solicitações pendentes e convites sem aceite.
  const people = useMemo(() => {
    const by: Record<string, Person[]> = {};
    const add = (unitId: string | null, p: Person) => { if (unitId) (by[unitId] ||= []).push(p); };
    for (const m of members || []) if (m.role === 'morador') for (const x of m.units || []) add(x.unit_id, {
      key: `m${m.membership_id}${x.unit_id}`, kind: 'member', name: m.full_name || m.email, email: m.email, phone: null, raw: m,
      status: m.status === 'pending' ? 'pending' : m.status === 'active' && x.status === 'active' ? 'active' : 'revoked' });
    for (const r of requests) add(r.unit_id, { key: `r${r.id}`, kind: 'request', name: r.full_name, email: r.email, phone: r.phone || null, status: 'pending', raw: r });
    for (const i of invites) add(i.unit_id, { key: `i${i.id}`, kind: 'invite', name: i.email, email: i.email, phone: null, status: 'invited', raw: i });
    return by;
  }, [members, requests, invites]);

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
          {current === 'unidades' && <UnitsTab units={units} people={people} isAdmin={isAdmin} canApprove={canApprove} onAdd={() => setAdding(true)} onImport={() => setImporting(true)}
            onInvite={(id) => setInvite({ role: 'morador', unitId: id })} onChanged={load} />}
          {current === 'moradores' && <ResidentsTab members={members} invites={invites} requests={requests} unitsById={unitsById} canApprove={canApprove} onChanged={load} />}
          {current === 'solicitacoes' && <AccessRequests units={units} onDecided={load} />}
          {current === 'nao-identificado' && <UnidentifiedTab rows={unidentified} units={units} people={people} onChanged={load}
            onInvite={(id) => setInvite({ role: 'morador', unitId: id })} />}
          {current === 'importados' && <ImportResidents units={units} />}
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

function UnitsTab({ units, people, isAdmin, canApprove, onAdd, onImport, onInvite, onChanged }: {
  units: UnitRow[]; people: Record<string, Person[]>; isAdmin: boolean; canApprove: boolean; onAdd: () => void; onImport: () => void; onInvite: (id: string) => void; onChanged: () => void;
}) {
  const t = useTenant();
  const labels = useUnitLabels();
  const [f, setF] = useState<Filter>({ q: '', block: '', status: '' });
  const df = useDebounced(f);
  const [limit, setLimit] = useState(PAGE);
  const [generating, setGenerating] = useState(false);
  const [panel, setPanel] = useState<UnitRow | null>(null);
  const { run } = useAction();
  const active = units.filter((u) => u.active).length;
  const blocks = useMemo(() => distinctBlocks(units), [units]);
  const max = (t.overview as any)?.entitlements?.max_units;
  const shown = useMemo(() => {
    const inBlock = blockMatcher(blocks, df.block);
    const q = df.q.trim();
    return units.map((u) => {
      const ps = people[u.id] || [];
      const hits = ps.filter((p) => (!df.status || p.status === df.status) && (!q || textMatches(`${p.name} ${p.email || ''}`, q)));
      const score = q ? Math.max(unitScore(u, q) * 2, hits.length ? 1 : 0) : 1;
      return { u, score, ps: q && !unitScore(u, q) ? hits : ps.filter((p) => !df.status || p.status === df.status) };
    }).filter((x) => inBlock(x.u.block) && x.score > 0 && (!df.status || x.ps.length))
      .sort((a, b) => b.score - a.score || naturalCompare(a.u.block || '', b.u.block || '') || naturalCompare(a.u.label, b.u.label));
  }, [units, people, blocks, df]);
  useEffect(() => setLimit(PAGE), [df]);
  const group = labels.group.toLocaleLowerCase('pt-BR');
  const toggle = (u: UnitRow) => {
    const name = unitName(u.block, u.label, labels);
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
            <Button onClick={() => setGenerating(true)}><Plus className="w-4 h-4" /> Montar unidades em lote</Button>
            <Button variant="secondary" onClick={onAdd} data-tour="unidades-form">Nova unidade</Button>
            <Button variant="secondary" onClick={onImport} data-tour="unidades-importar"><Upload className="w-4 h-4" /> Importar CSV</Button>
          </div>
        )}
      </div>
      <Filters f={f} set={setF} blocks={blocks} label="Buscar unidade"
        placeholder={`${labels.group} e ${labels.number.toLocaleLowerCase('pt-BR')} (ex.: 15B-22, 1A/11) ou nome do morador`} />
      <p className="text-xs text-muted" aria-live="polite">{shown.length} unidade(s){f.q || f.block || f.status ? ' encontrada(s)' : ''}. Toque na unidade para ver moradores e ações.</p>
      {shown.length === 0
        ? <Empty title={units.length ? 'Nenhuma unidade encontrada' : 'Nenhuma unidade cadastrada'}>{units.length ? null : 'Use “Nova unidade” ou importe uma planilha.'}</Empty>
        : (
          <ul className="divide-y divide-line" data-tour="unidades-lista">
            {shown.slice(0, limit).map(({ u, ps }) => (
              <li key={u.id} className="py-1 flex items-center justify-between gap-2 text-sm">
                <button className="min-w-0 flex-1 text-left min-h-11 py-1 rounded-lg hover:bg-surface-2 px-1" onClick={() => setPanel(u)} aria-label={`Abrir ${unitName(u.block, u.label, labels)}`}>
                  <span className={`font-medium ${u.active ? '' : 'text-muted line-through'}`}>{unitName(u.block, u.label, labels)}</span>
                  {ps.length > 0 && <span className="block text-xs space-y-0.5">{ps.slice(0, 3).map((p) => <span key={p.key} className="block"><PersonLine p={p} canApprove={canApprove} /></span>)}
                    {ps.length > 3 && <span className="text-muted">+{ps.length - 3}</span>}</span>}
                </button>
                {isAdmin && <RowMenu label={`Ações de ${unitName(u.block, u.label, labels)}`} items={[
                  ...(canApprove && u.active ? [{ label: 'Convidar morador (opcional)', onClick: () => onInvite(u.id) }] : []),
                  { label: u.active ? 'Desativar unidade' : 'Reativar unidade', danger: u.active, onClick: () => toggle(u) },
                ]} />}
              </li>
            ))}
          </ul>
        )}
      {shown.length > limit && <Button variant="ghost" onClick={() => setLimit(limit + PAGE)}>Mostrar mais ({shown.length - limit} restantes)</Button>}
      {generating && <GenerateUnitsModal onClose={() => setGenerating(false)} onDone={() => { setGenerating(false); onChanged(); }} />}
      {panel && <UnitPanel unit={panel} people={people[panel.id] || []} units={units} canApprove={canApprove} onClose={() => setPanel(null)} onChanged={onChanged}
        onInvite={() => { const id = panel.id; setPanel(null); onInvite(id); }} />}
    </Card>
  );
}

/** Painel da unidade: moradores (vínculos, solicitações, convites) com as ações já existentes. */
function UnitPanel({ unit, people, units, canApprove, onClose, onChanged, onInvite }: {
  unit: UnitRow; people: Person[]; units: UnitRow[]; canApprove: boolean; onClose: () => void; onChanged: () => void; onInvite: () => void;
}) {
  const t = useTenant();
  const [edit, setEdit] = useState<any>(null);
  const [del, setDel] = useState<any>(null);
  const { busy, run } = useAction();
  const name = unitName(unit.block, unit.label, t.unitLabels);
  const done = (close: (v: null) => void) => () => { close(null); onChanged(); };
  const setStatus = (m: any, status: 'active' | 'revoked') => {
    const who = m.full_name || m.email;
    if (!confirm(status === 'revoked' ? `Revogar o acesso de ${who}? O histórico é mantido e o acesso pode ser reativado.` : `Reativar o acesso de ${who}?`)) return;
    run(async () => { await rpc('set_membership_status', { p_membership: m.membership_id, p_status: status }); onChanged(); }, 'Acesso atualizado.');
  };
  const decide = (r: any, approve: boolean) => run(async () => {
    const reason = approve ? null : prompt('Motivo da recusa (o morador verá esta mensagem):');
    if (!approve && (!reason || reason.trim().length < 3)) throw new Error('Informe o motivo da recusa.');
    await rpc('decide_access_request', { p_request: r.id, p_approve: approve, p_unit: unit.id, p_reason: reason });
    onChanged(); dispatchEvent(new Event('pp:access-requests'));
  }, approve ? 'Cadastro aprovado.' : 'Solicitação recusada.');
  // create_invitation revoga o convite pendente anterior do mesmo e-mail/unidade: reenviar = novo convite.
  const resend = (i: any) => run(async () => {
    const r = await api<{ manualLink?: string }>('/api/invitations/send', { tenantId: t.tenant.id, email: i.email, role: 'morador', unitId: unit.id, permissions: [] });
    if (r.manualLink) { await navigator.clipboard?.writeText(r.manualLink).catch(() => {}); toast.warn('E-mail indisponível: link do convite copiado para envio manual.'); }
    else toast.success('Convite reenviado.');
    onChanged();
  });
  if (edit) return <ResidentEditModal userId={edit.user_id} units={units} onClose={() => setEdit(null)} onDone={done(setEdit)} />;
  if (del) return <ResidentDeleteModal member={del} onClose={() => setDel(null)} onDone={done(setDel)} />;
  return (
    <Modal title={`Unidade ${name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {!unit.active && <Alert tone="warning">Unidade desativada.</Alert>}
        {people.length === 0 ? <Empty title="Nenhum morador nesta unidade" /> : (
          <ul className="divide-y divide-line">
            {people.map((p) => (
              <li key={p.key} className="py-2 space-y-2">
                <PersonLine p={p} canApprove={canApprove} />
                {canApprove && <div className="flex flex-wrap gap-1">
                  {p.kind === 'request' && <>
                    <Button loading={busy} onClick={() => decide(p.raw, true)}>Aprovar</Button>
                    <Button variant="ghost" loading={busy} onClick={() => decide(p.raw, false)}>Reprovar</Button>
                  </>}
                  {p.kind === 'member' && <>
                    {p.status !== 'active' && <Button loading={busy} onClick={() => setStatus(p.raw, 'active')}>Aprovar</Button>}
                    {p.status === 'active' && <Button variant="ghost" loading={busy} onClick={() => setStatus(p.raw, 'revoked')}>Revogar</Button>}
                    <Button variant="ghost" onClick={() => setEdit(p.raw)}>Editar</Button>
                    <Button variant="ghost" className="text-danger" onClick={() => setDel(p.raw)}>Excluir</Button>
                  </>}
                  {p.kind === 'invite' && <>
                    <Button variant="secondary" loading={busy} onClick={() => resend(p.raw)}>Reenviar convite</Button>
                    <Button variant="ghost" loading={busy} onClick={() => run(async () => { await rpc('revoke_invitation', { p_invitation: p.raw.id }); onChanged(); }, 'Convite revogado.')}>Revogar convite</Button>
                  </>}
                </div>}
              </li>
            ))}
          </ul>
        )}
        {canApprove && unit.active && <Button variant="secondary" onClick={onInvite}>Convidar morador para esta unidade</Button>}
      </div>
    </Modal>
  );
}

function GenerateUnitsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const labels = useUnitLabels();
  const g = labels.group.toLocaleLowerCase('pt-BR'), n = labels.number.toLocaleLowerCase('pt-BR');
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
    <Modal title="Montar unidades em lote" onClose={onClose} wide>
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">1. Como se identifica cada {g}?</legend>
          <div className="flex flex-wrap gap-2">{([['letra', 'Por letra (A, B…)'], ['numero', 'Por número (1, 2…)'], ['nome', 'Cada um com um nome'], ['sem', `Sem ${g}`]] as const).map(([k, l]) =>
            <label key={k} className={`min-h-10 px-3 rounded-xl border text-sm inline-flex items-center gap-2 cursor-pointer ${style === k ? 'border-primary bg-surface-2' : 'border-line'}`}>
              <input type="radio" name="style" checked={style === k} onChange={() => { setStyle(k); setPreview(null); }} />{l}</label>)}</div>
          {(style === 'letra' || style === 'numero') && <Field label={`Quantidade (${g})`}><Input type="number" className="w-24" min={1} max={60} value={count} onChange={(e) => { setCount(+e.target.value || 1); setPreview(null); }} /></Field>}
          {style === 'nome' && <Field label={`Nomes (${g})`} hint="Um por linha ou separados por vírgula. Ex.: Ipê, Jacarandá, Manacá">
            <textarea className="w-full min-h-20 rounded-xl border border-line bg-surface px-3 py-2 text-sm" value={names} onChange={(e) => { setNames(e.target.value); setPreview(null); }} /></Field>}
          {style !== 'sem' && <p className="text-xs text-muted">{labels.group}: {blocks.join(', ') || '—'}</p>}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">2. Como é a numeração ({n})? Igual em todos ({g})</legend>
          <div className="flex flex-wrap gap-2">{([['floors', 'Por andar (101, 102… 201…)'], ['range', 'Sequência (1, 2, 3… ou Casa 1…)']] as const).map(([k, l]) =>
            <label key={k} className={`min-h-10 px-3 rounded-xl border text-sm inline-flex items-center gap-2 cursor-pointer ${mode === k ? 'border-primary bg-surface-2' : 'border-line'}`}>
              <input type="radio" name="mode" checked={mode === k} onChange={() => { setMode(k); setPreview(null); }} />{l}</label>)}</div>
          <div className="flex flex-wrap gap-3 items-end">
            {mode === 'floors' ? <>{field('floor_from', 'Do andar')}{field('floor_to', 'até o andar')}{field('per_floor', 'Unidades por andar')}</>
              : <>{field('from', 'Do número')}{field('to', 'até')}{field('prefix', 'Prefixo (opcional)', 'w-32')}</>}
          </div>
          {mode === 'floors' && <p className="text-xs text-muted">Numeração: andar × 100 + posição. Ex.: 1º andar com 4 unidades = 101 a 104; 10º andar = 1001 a 1004.</p>}
        </fieldset>
        <p className="text-sm">Serão criadas <strong>{total.toLocaleString('pt-BR')}</strong> unidade(s){blocks.length > 1 ? ` em ${blocks.length} (${g})` : ''}.</p>
        {total > 2000 && <Alert tone="warning">O máximo por vez é 2.000 unidades. Monte em partes (por exemplo, alguns de cada vez).</Alert>}
        {preview && <div className="space-y-2">
          {preview.errors?.length > 0
            ? <Alert tone="danger">{preview.errors.length} unidade(s) com problema (ex.: já cadastradas). Nada será gravado enquanto houver erro.<ul className="mt-1 text-xs">{preview.errors.slice(0, 8).map((e: any) => <li key={e.line}>Item {e.line}: {e.error}</li>)}</ul></Alert>
            : <Alert tone="success">Conferido: {preview.valid} unidade(s) prontas para cadastrar.</Alert>}
          <div className="max-h-40 overflow-y-auto rounded-xl bg-surface-2 p-3 text-xs flex flex-wrap gap-1">
            {(preview.preview || []).map((u: any, i: number) => <span key={i} className="px-2 py-0.5 rounded-full bg-surface border border-line">{unitName(u.block, u.label, labels)}</span>)}
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
  const labels = useUnitLabels();
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
        <Field label={`${labels.group} (opcional)`}><Input value={block} maxLength={30} onChange={(e) => setBlock(e.target.value)} /></Field>
        <Field label={labels.number} error={error}><Input required maxLength={30} placeholder="101A, Casa 12…" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Button type="submit" loading={busy} className="w-full">Adicionar unidade</Button>
      </form>
    </Modal>
  );
}

function ResidentsTab({ members, invites, requests, unitsById, canApprove, onChanged }: {
  members: any[] | null; invites: any[]; requests: any[]; unitsById: Record<string, UnitRow>; canApprove: boolean; onChanged: () => void;
}) {
  const t = useTenant();
  const [f, setF] = useState<Filter>({ q: '', block: '', status: '' });
  const df = useDebounced(f);
  const [limit, setLimit] = useState(PAGE);
  const [edit, setEdit] = useState<any>(null);
  const [del, setDel] = useState<any>(null);
  const [editInvite, setEditInvite] = useState<any>(null);
  const { run } = useAction();
  const units = useMemo(() => Object.values(unitsById), [unitsById]);
  const blocks = useMemo(() => distinctBlocks(units), [units]);
  useEffect(() => setLimit(PAGE), [df]);
  if (!members) return <Spinner />;
  const done = (close: (v: null) => void) => () => { close(null); onChanged(); };
  const residents = members.filter((m) => m.role === 'morador');
  const unitOfRow = (unitId: string | null) => (unitId ? unitsById[unitId] : null);
  // Mesmo filtro da aba Unidades: unidade ("15B-22", "1A") ou nome/e-mail sem acento; bloco; situação.
  const inBlock = blockMatcher(blocks, df.block);
  const q = df.q.trim();
  const isUnitQ = !!q && !!parseUnitQuery(q);
  const rowMatch = (text: string, us: { block: string | null; label: string }[], st: PersonStatus) =>
    (!df.status || st === df.status) && (!df.block || us.some((u) => inBlock(u.block)))
    && (!q || textMatches(text, q) || (isUnitQ && us.some((u) => unitScore(u, q) > 0)));
  const activeUnits = (m: any) => (m.units || []).filter((x: any) => x.status === 'active');
  const pendingReqs = requests.filter((r) => rowMatch(`${r.full_name} ${r.email}`, [unitOfRow(r.unit_id)].filter(Boolean) as UnitRow[], 'pending'));
  const invitesShown = invites.filter((i) => rowMatch(i.email, [unitOfRow(i.unit_id)].filter(Boolean) as UnitRow[], 'invited'));
  const resetPw = (m: any) => {
    if (!confirm(`Enviar a ${m.full_name || m.email} um e-mail com o link para criar uma nova senha? Você não vê nem define a senha do morador.`)) return;
    run(async () => {
      const r = await api<{ email: string }>('/api/team/resident-reset', { tenantId: t.tenant.id, userId: m.user_id });
      toast.success(`Link enviado para ${r.email}.`);
    });
  };
  const unitsOf = (m: any) => activeUnits(m).map((x: any) => unitName(x.block, x.label, t.unitLabels)).join(', ');
  const shown = residents.filter((m) => rowMatch(`${m.full_name || ''} ${m.email} ${unitsOf(m)}`, m.units || [], memberStatus(m)))
    .sort((a, b) => (isUnitQ ? Math.max(0, ...(b.units || []).map((u: any) => unitScore(u, q))) - Math.max(0, ...(a.units || []).map((u: any) => unitScore(u, q))) : 0));
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
        <Filters f={f} set={setF} blocks={blocks} label="Buscar morador" placeholder="Nome (sem acento), e-mail ou unidade (ex.: 15B 22)" />
        {pendingReqs.length > 0 && (!df.status || df.status === 'pending') && (
          <ul className="rounded-xl border border-warning/40 bg-warning-bg divide-y divide-line text-sm" aria-label="Solicitações pendentes encontradas">
            {pendingReqs.slice(0, 10).map((r) => { const u = unitOfRow(r.unit_id); return (
              <li key={r.id} className="px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0"><strong>{r.full_name}</strong> <Badge tone="warning">pendente</Badge> <span className="text-muted">· {u ? unitName(u.block, u.label, t.unitLabels) : [r.block_text, r.unit_text].filter(Boolean).join(' ')}{canApprove ? ` · ${[r.phone && maskPhone(r.phone), r.email].filter(Boolean).join(' · ')}` : ''}</span></span>
                <a href={`/c/${t.tenant.slug}/pessoas?aba=solicitacoes`} onClick={onLink} className="underline min-h-10 inline-flex items-center">Revisar</a>
              </li>
            ); })}
          </ul>
        )}
        {shown.length === 0
          ? <Empty title={residents.length ? 'Nenhum morador encontrado' : 'Nenhum morador ainda'}>{residents.length ? null : 'Compartilhe o link do portal do condomínio para os moradores pedirem acesso.'}</Empty>
          : (
            <ul className="divide-y divide-line">
              {shown.slice(0, limit).map((m) => {
                const us = unitsOf(m);
                const [tone, text] = STATUS_BADGE[memberStatus(m)];
                return (
                  <li key={m.membership_id} className="py-2 flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{m.full_name || <span className="text-muted">Sem nome</span>} <Badge tone={tone}>{text}</Badge></p>
                      <p className="text-muted truncate">{us || 'sem unidade ativa'}{canApprove ? ` · ${m.email}` : ''}</p>
                    </div>
                    {canApprove && <RowMenu label={`Ações de ${m.full_name || m.email}`} items={[
                      { label: 'Editar cadastro', onClick: () => setEdit(m) },
                      ...(m.status === 'active' ? [{ label: 'Enviar link de nova senha', onClick: () => resetPw(m) }] : []),
                      { label: m.status === 'active' ? 'Revogar acesso' : 'Reativar acesso', danger: m.status === 'active', onClick: () => toggle(m) },
                      { label: 'Excluir cadastro', danger: true, onClick: () => setDel(m) },
                    ]} />}
                  </li>
                );
              })}
            </ul>
          )}
        {shown.length > limit && <Button variant="ghost" onClick={() => setLimit(limit + PAGE)}>Mostrar mais ({shown.length - limit} restantes)</Button>}
      </Card>
      {invitesShown.length > 0 && (
        <Card className="space-y-2">
          <p className="font-semibold">Convites de morador pendentes ({invitesShown.length}{invitesShown.length !== invites.length ? ` de ${invites.length}` : ''})</p>
          <ul className="divide-y divide-line">
            {invitesShown.map((i) => {
              const u = i.unit_id ? unitsById[i.unit_id] : null;
              return (
                <li key={i.id} className="py-2 flex flex-wrap justify-between items-center gap-2 text-sm">
                  <span className="min-w-0 break-all">{i.email}{u ? ` · ${unitName(u.block, u.label, t.unitLabels)}` : ''} <span className="text-muted">· expira {new Date(i.expires_at).toLocaleDateString('pt-BR')}</span></span>
                  {canApprove && <span className="flex gap-1">
                    <Button variant="ghost" onClick={() => setEditInvite(i)}>Editar</Button>
                    <Button variant="ghost" onClick={() => run(async () => { await rpc('revoke_invitation', { p_invitation: i.id }); onChanged(); }, 'Convite revogado.')}>Revogar</Button>
                  </span>}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {edit && <ResidentEditModal userId={edit.user_id} units={units} onClose={() => setEdit(null)} onDone={done(setEdit)} />}
      {del && <ResidentDeleteModal member={del} onClose={() => setDel(null)} onDone={done(setDel)} />}
      {editInvite && <InvitationEditModal invite={editInvite} units={units} onClose={() => setEditInvite(null)} onDone={done(setEditInvite)} />}
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
    <Modal title={role === 'morador' ? `Convidar morador — ${unitName(unit?.block, unit?.label, t.unitLabels)}` : 'Convidar equipe'} onClose={link ? onDone : onClose}>
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
  const labels = useUnitLabels();
  const g = labels.group.toLocaleLowerCase('pt-BR'), n = labels.number.toLocaleLowerCase('pt-BR');
  const [rows, setRows] = useState<{ block: string; label: string }[] | null>(null);
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const onFile = async (f: File) => {
    if (f.size > 1024 * 1024) return toast.error('Arquivo muito grande (máx. 1 MB).');
    const parsed = parseCsv(await f.text());
    const header = parsed[0]?.map((h) => h.toLowerCase());
    const hasHeader = header?.some((h) => /bloco|torre|unidade|apto|apartamento|quadra|rua|lote|casa/.test(h) || h === g || h === n);
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
        <p className="text-muted">Colunas: <code>{g};{n}</code> ({g} pode ficar vazio). Ex.: <code>A;101</code>, <code>;12</code>. Nada é gravado antes da prévia sem erros.</p>
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
  const [editReq, setEditReq] = useState<any>(null);
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
  const cancel = (r: any) => {
    if (!confirm(`Cancelar a solicitação de ${r.full_name}? A pessoa não é avisada; o aceite do termo fica registrado e ela pode pedir de novo pelo portal.`)) return;
    run(async () => {
      await rpc('access_request_cancel', { p_request: r.id });
      await load();
      dispatchEvent(new Event('pp:access-requests'));
    }, 'Solicitação cancelada.');
  };
  if (!rows) return <Spinner />;
  return (
    <Card className="space-y-3" data-tour="solicitacoes">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <p className="font-semibold">Solicitações de cadastro {status === 'pending' ? `(${rows.length})` : ''}</p>
        <Select aria-label="Filtrar solicitações" value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="pending">Pendentes</option><option value="approved">Aprovadas</option><option value="rejected">Recusadas</option><option value="cancelled">Canceladas</option><option value="">Todas</option>
        </Select>
      </div>
      {rows.length === 0 ? <Empty title="Nenhuma solicitação">{status === 'pending' ? 'Moradores pedem acesso pelo link do portal do condomínio. Os pedidos aparecem aqui para aprovação.' : null}</Empty> : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="py-3 space-y-2 text-sm">
              <p><strong>{r.full_name}</strong> <span className="text-muted">{r.email}{r.phone ? ` · ${maskPhone(r.phone)}` : ''}</span>
                {r.email_verified === false && <> <Badge tone="warning">e-mail não confirmado</Badge></>}</p>
              <p>Informou: <strong>{[r.block_text, r.unit_text].filter(Boolean).join(' ')}</strong>{relationLabel(r.relation) && <> · {relationLabel(r.relation)}</>} · {new Date(r.created_at).toLocaleString('pt-BR')}
                {r.status !== 'pending' && <> · <Badge tone={r.status === 'approved' ? 'success' : r.status === 'cancelled' ? 'neutral' : 'danger'}>{{ approved: 'aprovada', cancelled: 'cancelada' }[r.status as string] || 'recusada'}</Badge>{r.reason ? ` ${r.reason}` : ''}</>}</p>
              <p>{r.privacy_version
                ? <Badge tone="success">Termo de dados {r.privacy_version} aceito em {new Date(r.privacy_accepted_at).toLocaleString('pt-BR')}</Badge>
                : <Badge tone="warning">Sem aceite do termo de dados registrado</Badge>}
                {!r.privacy_version && r.status === 'pending' && <span className="block text-xs text-muted mt-1">Pedidos enviados depois da publicação do termo só podem ser aprovados com o aceite. Recusar continua possível.</span>}</p>
              {r.status === 'pending' && (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={r.unit_id ? 'Unidade (encontrada)' : 'Unidade não encontrada: escolha'}>
                    <Select value={pick[r.id] ?? r.unit_id ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                      <option value="">Selecione…</option>
                      {active.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}
                    </Select>
                  </Field>
                  <Button loading={busy} disabled={!(pick[r.id] || r.unit_id)} onClick={() => decide(r, true)}>Aprovar</Button>
                  <Button variant="ghost" loading={busy} onClick={() => decide(r, false)}>Recusar</Button>
                  <Button variant="ghost" onClick={() => setEditReq(r)}>Editar</Button>
                  <Button variant="ghost" loading={busy} onClick={() => cancel(r)}>Cancelar</Button>
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
      {editReq && <AccessRequestEditModal request={editReq} units={units} onClose={() => setEditReq(null)} onDone={() => { setEditReq(null); load(); }} />}
    </Card>
  );
}

const PERSON_TEXT: Record<string, [string, 'success' | 'warning' | 'danger']> = { active: ['ativo', 'success'], pending: ['pendente', 'warning'], revoked: ['revogado', 'danger'] };

/** Encomendas marcadas pela portaria como "morador não identificado" (somente quem aprova). Continuam retiráveis. */
function UnidentifiedTab({ rows, units, people, onChanged, onInvite }: {
  rows: any[] | null; units: UnitRow[]; people: Record<string, Person[]>; onChanged: () => void; onInvite: (unitId: string) => void;
}) {
  const t = useTenant();
  const [fix, setFix] = useState<any>(null);
  if (!rows) return <Spinner />;
  if (rows.length === 0) return <Card><Empty title="Nenhuma encomenda com morador não identificado">Quando a portaria marcar “Morador não identificado” no recebimento, a encomenda aparece aqui para você corrigir ou destinar.</Empty></Card>;
  return (
    <div className="space-y-3">
      <Alert tone="warning">A encomenda continua guardada e pode ser retirada normalmente. Corrija a unidade/destinatário ou convide o morador.</Alert>
      <ul className="space-y-3" aria-label="Encomendas com morador não identificado">
        {rows.map((p) => (
          <li key={p.id}>
            <Card className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <LabelPhoto path={p.label_photo_path} />
              <div className="min-w-0 space-y-2 text-sm">
                <p className="font-semibold">{unitName(p.unit_block, p.unit_label, t.unitLabels)} <span className="font-normal text-muted">· {p.carrier}</span>{' '}
                  <Badge tone="warning">{(UNIDENTIFIED_REASONS as Record<string, string>)[p.unidentified_reason] || 'Não identificado'}</Badge></p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <dt className="text-muted">Nome na etiqueta</dt><dd className="break-words">{p.recipient_name || '—'}</dd>
                  <dt className="text-muted">Rastreio</dt><dd className="break-all">{p.tracking_code || 'sem rastreio'}</dd>
                  <dt className="text-muted">Recebida em</dt><dd>{dateTime(p.received_at, t.tenant.timezone)}</dd>
                  <dt className="text-muted">Recebido por</dt><dd>{p.received_by_name || '—'}</dd>
                </dl>
                <div>
                  <p className="text-muted">Moradores da unidade</p>
                  {(p.residents || []).length === 0 ? <p>Nenhum morador cadastrado nesta unidade.</p> : (
                    <ul className="space-y-0.5">{p.residents.map((r: any, i: number) => { const [l, tone] = PERSON_TEXT[r.status] || [r.status, 'warning']; return (
                      <li key={i}>{r.name} <Badge tone={tone}>{l}</Badge>{(r.phone || r.email) && <span className="text-muted break-all"> · {[r.phone && maskPhone(r.phone), r.email].filter(Boolean).join(' · ')}</span>}</li>
                    ); })}</ul>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setFix(p)}>Corrigir / Destinar</Button>
                  {p.unit_id && <Button variant="secondary" onClick={() => onInvite(p.unit_id)}>Convidar morador para esta unidade</Button>}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {fix && <DestinateModal pkg={fix} units={units} people={people} onClose={() => setFix(null)} onDone={() => { setFix(null); onChanged(); }} />}
    </div>
  );
}

function LabelPhoto({ path }: { path: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { if (path) signedUrl(path).then(setUrl).catch(() => setErr(true)); }, [path]);
  if (!path || err) return <div className="aspect-square w-full max-w-32 rounded-xl bg-surface-2 grid place-items-center text-xs text-muted text-center p-2">{path ? 'Foto indisponível' : 'Sem foto da etiqueta'}</div>;
  if (!url) return <div className="aspect-square w-full max-w-32 rounded-xl bg-surface-2 animate-pulse" />;
  return <a href={url} target="_blank" rel="noreferrer" className="block"><img src={url} alt="Foto da etiqueta" className="w-full max-w-32 aspect-square object-cover rounded-xl border border-line" /></a>;
}

function DestinateModal({ pkg, units, people, onClose, onDone }: { pkg: any; units: UnitRow[]; people: Record<string, Person[]>; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [unit, setUnit] = useState<string>(pkg.unit_id || '');
  const [resident, setResident] = useState('');
  const [recipient, setRecipient] = useState(pkg.recipient_name || '');
  const { busy, run } = useAction();
  const active = units.filter((u) => u.active).sort((a, b) => naturalCompare(a.block || '', b.block || '') || naturalCompare(a.label, b.label));
  const residents = (people[unit] || []).filter((p) => p.kind === 'member' && p.status === 'active');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await rpc('package_destinate', { p_tenant: t.tenant.id, p_package: pkg.id, p_unit: unit, p_recipient: resident ? null : recipient, p_resident_user: resident || null });
      onDone();
    }, 'Encomenda destinada.');
  };
  return (
    <Modal title="Corrigir / Destinar encomenda" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Unidade">
          <Select required value={unit} onChange={(e) => { setUnit(e.target.value); setResident(''); }}>
            <option value="">Selecione…</option>
            {active.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}
          </Select>
        </Field>
        <Field label="Morador" hint={residents.length ? 'Escolha um morador ativo ou informe o nome abaixo.' : 'Nenhum morador ativo nesta unidade: informe o nome do destinatário.'}>
          <Select value={resident} onChange={(e) => setResident(e.target.value)} disabled={!residents.length}>
            <option value="">Outro (informar nome)</option>
            {residents.map((p) => <option key={p.key} value={p.raw.user_id}>{p.name}</option>)}
          </Select>
        </Field>
        {!resident && <Field label="Nome do destinatário"><Input value={recipient} maxLength={120} onChange={(e) => setRecipient(e.target.value)} /></Field>}
        {unit !== pkg.unit_id && unit && <p className="text-xs text-muted">Ao trocar de unidade, os moradores da nova unidade são avisados e o QR anterior deixa de valer.</p>}
        <Button type="submit" loading={busy} disabled={!unit} className="w-full">Salvar destino</Button>
      </form>
    </Modal>
  );
}
