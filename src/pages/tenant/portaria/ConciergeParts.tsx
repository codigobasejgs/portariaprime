import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Camera, DoorClosed, DoorOpen, Phone, Search } from 'lucide-react';
import { newKey, rpc } from '../../../lib/api';
import { useRefreshWhileVisible, useTenant } from '../../../lib/tenant';
import { dateTime, unitName } from '../../../lib/format';
import { loadUnits, type UnitRow } from '../../../lib/packages';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../../components/ui';

export const KIND: Record<string, string> = { visita: 'Visita', prestador: 'Prestador de serviço', entrega: 'Entregador', outro: 'Outro' };

export function useActiveUnits() {
  const t = useTenant();
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  useEffect(() => { loadUnits(t.tenant.id).then((u) => setUnits(u.filter((x) => x.active))).catch(() => setUnits([])); }, [t.tenant.id]);
  return units;
}

/**
 * Entrada sem convite (versão completa): busca o cadastro (visitante frequente, prestador ou entregador de Encomendas)
 * para não duplicar a pessoa; bloqueado não entra e a tentativa fica registrada. Não aciona portão.
 */
export function EntryModal({ onClose, onDone, kind: startKind = 'visita' }: { onClose: () => void; onDone: (r: any) => void; kind?: string }) {
  const t = useTenant();
  const units = useActiveUnits();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [couriers, setCouriers] = useState<any[]>([]);
  const [pick, setPick] = useState<any | null>(null);
  const [f, setF] = useState({ unit: '', name: '', kind: startKind, doc: '', company: '', by: '', reason: '', notes: '', courier: '' });
  const [key] = useState(newKey);
  const { busy, run } = useAction();
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); setCouriers([]); return; }
    const id = setTimeout(() => {
      rpc<any[]>('visitor_profile_search', { p_tenant: t.tenant.id, p_query: q }).then(setFound).catch(() => setFound([]));
      if (f.kind === 'entrega') rpc<any[]>('courier_search', { p_tenant: t.tenant.id, p_query: q }).then(setCouriers).catch(() => setCouriers([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, f.kind, t.tenant.id]);
  const choose = (p: any) => { setPick(p); setF((x) => ({ ...x, name: p.full_name, kind: p.kind || x.kind, doc: p.document_last4 || '', company: p.company || '', courier: p.courier_id || '' })); };
  const chooseCourier = (c: any) => { setPick({ courier: true, full_name: c.full_name }); setF((x) => ({ ...x, name: c.full_name, kind: 'entrega', courier: c.id, company: c.carrier_default || '' })); };
  const call = (confirmDistinct: boolean) => rpc<any>('visitor_entry', { p_tenant: t.tenant.id, p_idempotency_key: key, p_unit: f.unit, p_name: f.name, p_kind: f.kind,
    p_authorized_by: f.by, p_reason: f.reason || null, p_profile: pick && !pick.courier ? pick.id : null, p_document_last4: f.doc || null,
    p_company: f.company || null, p_notes: f.notes || null, p_courier: f.courier || null, p_confirm_distinct: confirmDistinct });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      let r;
      try { r = await call(false); } catch (err: any) {
        if (!/pessoa bloqueada com este nome/.test(err?.message || '') || !confirm('Há uma pessoa BLOQUEADA com este nome. Você conferiu o documento e é outra pessoa?')) throw err;
        r = await call(true);
      }
      if (r.denied) toast.error(`Entrada NÃO autorizada: ${r.visitor_name} está bloqueado(a). Motivo: ${r.reason}`);
      else toast.success(`Entrada de ${r.visitor_name} registrada.`);
      onDone(r);
    });
  };
  return (
    <Modal title="Registrar entrada" onClose={onClose}>
      {!units ? <Spinner /> : (
        <form className="space-y-3" onSubmit={submit}>
          <Field label="Tipo"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <label className="relative block">
            <span className="sr-only">Buscar cadastro</span>
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input className="pl-9" placeholder={f.kind === 'entrega' ? 'Buscar entregador (nome ou CPF)' : 'Buscar cadastro (nome ou empresa)'} value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} />
          </label>
          {(found.length > 0 || couriers.length > 0) && !pick && (
            <ul className="rounded-xl border border-line divide-y divide-line max-h-48 overflow-y-auto text-sm" aria-label="Cadastros encontrados">
              {couriers.map((c) => <li key={`c${c.id}`}><button type="button" className="w-full text-left px-3 py-2 hover:bg-surface-2" onClick={() => chooseCourier(c)}>
                {c.full_name} <span className="text-muted">· entregador{c.carrier_default ? ` · ${c.carrier_default}` : ''}{c.document_hint ? ` · CPF ${c.document_hint}` : ''}</span></button></li>)}
              {found.map((p) => <li key={p.id}><button type="button" className="w-full text-left px-3 py-2 hover:bg-surface-2" onClick={() => choose(p)}>
                {p.full_name} {p.blocked && <Badge tone="danger">Bloqueado</Badge>} <span className="text-muted">· {KIND[p.kind]}{p.company ? ` · ${p.company}` : ''} · {p.visits} visita(s)</span></button></li>)}
            </ul>
          )}
          {pick?.blocked && <Alert tone="danger">Pessoa bloqueada: {pick.blocked_reason}. Se registrar, a entrada fica como negada.</Alert>}
          <Field label="Unidade"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} required>
            <option value="">Selecione</option>{units.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}</Select></Field>
          <Field label="Nome"><Input value={f.name} onChange={(e) => { setF({ ...f, name: e.target.value }); setPick(null); }} minLength={2} required autoComplete="off" /></Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Documento (4 últimos)"><Input value={f.doc} onChange={(e) => setF({ ...f, doc: e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(-4) })} maxLength={4} inputMode="numeric" /></Field>
            <Field label="Empresa (opcional)"><Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} maxLength={80} /></Field>
          </div>
          <Field label="Quem autorizou" hint="Ex.: morador pelo interfone, síndico."><Input value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })} minLength={2} required /></Field>
          <Field label="Observação (opcional)"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} /></Field>
          <Button type="submit" loading={busy} className="w-full">Registrar entrada</Button>
          <p className="text-xs text-muted">Registrar a entrada não abre portão nem fechadura.</p>
        </form>
      )}
    </Modal>
  );
}

/** Entrega: marca as encomendas já recebidas pelo fluxo de Encomendas que vieram com este entregador (sem duplicar). */
export function LinkParcelsModal({ visit, onClose }: { visit: { id: string; visitor_name: string }; onClose: () => void }) {
  const t = useTenant();
  const [list, setList] = useState<any[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const { busy, run } = useAction();
  useEffect(() => { rpc<any[]>('visit_parcel_candidates', { p_tenant: t.tenant.id, p_visit: visit.id }).then((l) => { setList(l); setSel(new Set(l.filter((x) => x.linked).map((x) => x.id))); }).catch((e) => { toast.error(e.message); setList([]); }); }, [t.tenant.id, visit.id]);
  const save = () => run(async () => {
    const r = await rpc<any>('visit_link_parcels', { p_tenant: t.tenant.id, p_visit: visit.id, p_packages: [...sel] });
    toast.success(`${r.linked} encomenda(s) vinculada(s) à entrega.`); onClose();
  });
  return (
    <Modal title={`Encomendas de ${visit.visitor_name}`} onClose={onClose}>
      {!list ? <Spinner /> : list.length === 0 ? <Empty title="Nenhuma encomenda no período">Registre o recebimento em Encomendas; depois volte aqui para vincular.</Empty> : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Encomendas recebidas perto do horário desta entrega. Marque as que este entregador trouxe.</p>
          <ul className="divide-y divide-line text-sm">{list.map((p) => (
            <li key={p.id}><label className="flex items-center gap-2 py-2 min-h-11">
              <input type="checkbox" checked={sel.has(p.id)} disabled={p.linked} onChange={(e) => setSel((s) => { const n = new Set(s); e.target.checked ? n.add(p.id) : n.delete(p.id); return n; })} />
              <span>{p.carrier}{p.tracking_code ? ` · ${p.tracking_code}` : ''} · {p.unit || 'sem unidade'} · {dateTime(p.received_at, t.tenant.timezone)}</span>
            </label></li>))}</ul>
          <Button onClick={() => void save()} loading={busy} className="w-full">Vincular</Button>
        </div>
      )}
    </Modal>
  );
}

const CATEGORY: Record<string, string> = { seguranca: 'Segurança', manutencao: 'Manutenção', convivencia: 'Convivência', acesso: 'Acesso', encomenda: 'Encomenda', recado: 'Recado', outro: 'Outro' };
const SEVERITY: Record<string, ['neutral' | 'warning' | 'danger', string]> = { baixa: ['neutral', 'Baixa'], media: ['warning', 'Média'], alta: ['danger', 'Alta'] };

export function IncidentsTab() {
  const t = useTenant();
  const [status, setStatus] = useState<'aberta' | ''>('aberta');
  const [list, setList] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [closing, setClosing] = useState<any | null>(null);
  const load = useCallback(() => rpc<any[]>('incident_list', { p_tenant: t.tenant.id, p_status: status || null }).then((l) => { setList(l); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id, status]);
  useEffect(() => { void load(); }, [load]);
  if (!t.hasModule('incident')) return <Alert tone="warning">O módulo Ocorrências não está contratado neste condomínio.</Alert>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Field label="Mostrar"><Select value={status} onChange={(e) => setStatus(e.target.value as any)}><option value="aberta">Abertas</option><option value="">Todas</option></Select></Field>
        <Button onClick={() => setCreate(true)}><AlertTriangle className="w-4 h-4" aria-hidden /> Nova ocorrência</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!list && !error ? <Spinner /> : list && (list.length === 0 ? <Empty title="Nenhuma ocorrência">{status ? 'Nenhuma ocorrência aberta.' : 'Nada registrado ainda.'}</Empty> : (
        <ul className="divide-y divide-line">{list.map((i) => (
          <li key={i.id} className="py-2 flex flex-wrap items-start justify-between gap-2 text-sm">
            <div className="min-w-0"><p className="font-medium">{i.title} <Badge tone={SEVERITY[i.severity][0]}>{SEVERITY[i.severity][1]}</Badge></p>
              <p className="text-xs text-muted">{CATEGORY[i.category]}{i.unit ? ` · ${i.unit}` : ''} · {dateTime(i.created_at, t.tenant.timezone)}{i.created_by_name ? ` · ${i.created_by_name}` : ''}</p>
              {i.description && <p className="text-sm mt-1 whitespace-pre-wrap">{i.description}</p>}
              {i.resolution && <p className="text-xs text-muted mt-1">Encerrada: {i.resolution}</p>}</div>
            {i.status === 'aberta' && <Button variant="secondary" onClick={() => setClosing(i)}>Encerrar</Button>}
          </li>))}</ul>
      ))}
      {create && <IncidentModal onClose={() => setCreate(false)} onDone={() => { setCreate(false); void load(); }} />}
      {closing && <CloseIncident incident={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); void load(); }} />}
    </div>
  );
}

function IncidentModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const units = useActiveUnits();
  const [f, setF] = useState({ category: 'recado', severity: 'baixa', title: '', description: '', unit: '' });
  const [key] = useState(newKey);
  const { busy, run } = useAction();
  return (
    <Modal title="Nova ocorrência" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        await rpc('incident_create', { p_tenant: t.tenant.id, p_idempotency_key: key, p_category: f.category, p_title: f.title, p_description: f.description || null,
          p_severity: f.severity, p_unit: f.unit || null }); onDone(); }, 'Ocorrência registrada.'); }}>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Categoria"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Gravidade" hint="Alta avisa a administração."><Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v[1]}</option>)}</Select></Field>
        </div>
        <Field label="Título"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} minLength={3} maxLength={120} required /></Field>
        <Field label="Descrição (opcional)"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} rows={4}
          className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary" /></Field>
        <Field label="Unidade (opcional)"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
          <option value="">Nenhuma</option>{(units || []).map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}</Select></Field>
        <Button type="submit" loading={busy} className="w-full">Registrar</Button>
      </form>
    </Modal>
  );
}

function CloseIncident({ incident, onClose, onDone }: { incident: any; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [text, setText] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={`Encerrar: ${incident.title}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await rpc('incident_close', { p_tenant: t.tenant.id, p_incident: incident.id, p_resolution: text }); onDone(); }, 'Ocorrência encerrada.'); }}>
        <Field label="Como foi resolvida"><Input value={text} onChange={(e) => setText(e.target.value)} minLength={3} maxLength={1000} required /></Field>
        <Button type="submit" loading={busy} className="w-full">Encerrar</Button>
      </form>
    </Modal>
  );
}

const TL: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger' | 'accent']> = {
  parcel_received: ['Encomenda recebida', 'accent'], parcel_picked_up: ['Encomenda entregue', 'success'], visit_in: ['Entrada', 'success'],
  visit_out: ['Saída', 'neutral'], visit_denied: ['Entrada negada', 'danger'], incident: ['Ocorrência', 'warning'],
};

/** Histórico de acessos: encomendas, visitas e ocorrências do condomínio em ordem, por período e unidade. */
export function HistoryTab() {
  const t = useTenant();
  const units = useActiveUnits();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const [f, setF] = useState({ unit: '', from: day(new Date(Date.now() - 7 * 86400_000)), to: day(new Date()) });
  const [list, setList] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => rpc<any[]>('portaria_timeline', { p_tenant: t.tenant.id, p_unit: f.unit || null,
    p_from: new Date(`${f.from}T00:00:00`).toISOString(), p_to: new Date(`${f.to}T23:59:59`).toISOString(), p_limit: 300 })
    .then((l) => { setList(l); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id, f]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-3 gap-2">
        <Field label="Unidade"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
          <option value="">Todas</option>{(units || []).map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}</Select></Field>
        <Field label="De"><Input type="date" value={f.from} max={f.to} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="Até"><Input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!list && !error ? <Spinner /> : list && (list.length === 0 ? <Empty title="Nada no período" /> : (
        <ol className="divide-y divide-line" aria-label="Histórico de acessos">{list.map((e, i) => (
          <li key={`${e.type}${e.id}${i}`} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="min-w-0"><p className="font-medium"><Badge tone={TL[e.type]?.[1]}>{TL[e.type]?.[0] || e.type}</Badge> {e.title}</p>
              <p className="text-xs text-muted">{dateTime(e.at, t.tenant.timezone)}{e.unit ? ` · ${e.unit}` : ''}{e.detail ? ` · ${e.detail}` : ''}{e.parcels ? ` · ${e.parcels} encomenda(s)` : ''}</p></div>
          </li>))}</ol>
      ))}
    </div>
  );
}

const AP_ICON: Record<string, React.ElementType> = { portao_pedestre: DoorOpen, portao_veiculos: DoorClosed, porta: DoorClosed, cancela: DoorClosed, camera: Camera, interfone: Phone };
const AP_KIND: Record<string, string> = { portao_pedestre: 'Portão de pedestres', portao_veiculos: 'Portão de veículos', porta: 'Porta', cancela: 'Cancela', camera: 'Câmera', interfone: 'Interfone' };
const AP_STATUS: Record<string, [string, 'neutral' | 'warning' | 'success' | 'danger']> = {
  not_installed: ['Não instalado', 'neutral'], simulated: ['Simulado', 'warning'], pending_hardware: ['Aguardando homologação', 'warning'],
  homologated: ['Homologado', 'success'], offline: ['Offline', 'danger'],
};

/**
 * Pontos de acesso (portões, câmeras, interfones): só o cadastro e o estado REAL. Os botões de ação ficam visíveis e
 * desabilitados com o motivo, preparando a tela para P2 sem fingir que algo funciona.
 */
export function AccessPointsTab() {
  const t = useTenant();
  const [list, setList] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const { busy, run } = useAction();
  const load = useCallback(() => rpc<any[]>('access_points_list', { p_tenant: t.tenant.id }).then((l) => { setList(l); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  useRefreshWhileVisible(load, 30000);
  const canEdit = t.can('settings');
  return (
    <div className="space-y-3">
      <Alert>Câmeras, interfones e portões ainda não são acionados pelo Portaria Prime. Aqui ficam cadastrados com o estado real de cada um.</Alert>
      {canEdit && <Button variant="secondary" onClick={() => setEdit({ name: '', kind: 'portao_pedestre', location: '' })}>Cadastrar ponto de acesso</Button>}
      {error && <Alert tone="danger">{error}</Alert>}
      {!list && !error ? <Spinner /> : list && (list.length === 0 ? <Empty title="Nenhum ponto de acesso">{canEdit ? 'Cadastre portões, câmeras e interfones do condomínio.' : 'O síndico cadastra portões, câmeras e interfones.'}</Empty> : (
        <ul className="grid sm:grid-cols-2 gap-3">{list.map((a) => {
          const Icon = AP_ICON[a.kind] || DoorClosed;
          return (
            <li key={a.id}><Card className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold flex items-center gap-2"><Icon className="w-5 h-5" aria-hidden /> {a.name}</p>
                <Badge tone={AP_STATUS[a.status]?.[1]}>{AP_STATUS[a.status]?.[0] || a.status}</Badge>
              </div>
              <p className="text-xs text-muted">{AP_KIND[a.kind]}{a.location ? ` · ${a.location}` : ''}</p>
              <div className="flex flex-wrap gap-2">
                {a.kind === 'camera' ? <Button variant="secondary" disabled title="Disponível após homologar o equipamento (P2)">Ver ao vivo</Button>
                  : a.kind === 'interfone' ? <Button variant="secondary" disabled title="Disponível após homologar o equipamento (P2)">Chamar</Button>
                  : <Button variant="secondary" disabled title="Disponível após homologar o equipamento (P2)">Abrir</Button>}
                {canEdit && <Button variant="ghost" onClick={() => setEdit(a)}>Editar</Button>}
                {canEdit && <Button variant="ghost" onClick={() => { if (confirm(`Excluir ${a.name}?`)) void run(async () => { await rpc('access_point_delete', { p_tenant: t.tenant.id, p_id: a.id }); await load(); }); }} disabled={busy}>Excluir</Button>}
              </div>
            </Card></li>
          );
        })}</ul>
      ))}
      {edit && (
        <Modal title={edit.id ? 'Editar ponto de acesso' : 'Cadastrar ponto de acesso'} onClose={() => setEdit(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => {
            await rpc('access_point_save', { p_tenant: t.tenant.id, p_id: edit.id || null, p_name: edit.name, p_kind: edit.kind, p_location: edit.location || null });
            setEdit(null); await load(); }, 'Ponto de acesso salvo.'); }}>
            <Field label="Nome"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} minLength={2} maxLength={60} required placeholder="Ex.: Portão social" /></Field>
            <Field label="Tipo"><Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{Object.entries(AP_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Local (opcional)"><Input value={edit.location || ''} onChange={(e) => setEdit({ ...edit, location: e.target.value })} maxLength={80} /></Field>
            <Button type="submit" loading={busy} className="w-full">Salvar</Button>
          </form>
        </Modal>
      )}
    </div>
  );
}

/** Configuração do módulo (síndico com 'settings'): validade dos convites, entradas, documento e avisos. */
export function ConciergeSettingsCard() {
  const t = useTenant();
  const [cfg, setCfg] = useState<any | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { rpc('concierge_settings_get', { p_tenant: t.tenant.id }).then(setCfg).catch(() => setCfg(null)); }, [t.tenant.id]);
  if (!t.hasModule('visitors') || !cfg) return null;
  const n = (k: string, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, [k]: Math.min(max, Math.max(min, Number(e.target.value) || min)) });
  const b = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, [k]: e.target.checked });
  return (
    <Card className="space-y-3">
      <p className="font-semibold">Visitantes e convites</p>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { setCfg(await rpc('concierge_settings_save', { p_tenant: t.tenant.id, p_cfg: cfg })); }, 'Configuração salva.'); }}>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Validade padrão (horas)"><Input type="number" min={1} max={720} value={cfg.pass_default_hours} onChange={n('pass_default_hours', 1, 720)} /></Field>
          <Field label="Validade máxima (dias)"><Input type="number" min={1} max={30} value={cfg.pass_max_days} onChange={n('pass_max_days', 1, 30)} /></Field>
          <Field label="Entradas por convite (máx.)"><Input type="number" min={1} max={20} value={cfg.pass_max_uses} onChange={n('pass_max_uses', 1, 20)} /></Field>
        </div>
        {([['residents_can_invite', 'Moradores podem criar convites'], ['require_document', 'Exigir os 4 últimos dígitos do documento'],
          ['notify_resident_on_arrival', 'Avisar o morador quando a visita entrar']] as const).map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm min-h-11"><input type="checkbox" checked={!!cfg[k]} onChange={b(k)} /> {l}</label>
        ))}
        <Button type="submit" loading={busy}>Salvar</Button>
      </form>
    </Card>
  );
}
