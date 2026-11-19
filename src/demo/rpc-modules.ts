import { nowIso, store } from './store';
import { fail, myUnits, staff, tenant, unitText, WAITING, type Handler } from './rpc';

/**
 * Módulos novos na /demonstracao (mesmos nomes de RPC das migrations 20261118000100/0200): Visitantes e Central
 * ligados para mostrar o fluxo; dados fictícios em memória. Gateway: um simulador "online" claramente marcado.
 */
const CATALOG = [
  ['parcels', 'Encomendas', 'P0', false, true], ['visitors', 'Visitantes', 'P0', false, true], ['concierge', 'Portaria', 'P0', false, true],
  ['incident', 'Ocorrências', 'P1', false, true], ['cctv', 'Câmeras', 'P1', true, false], ['access_control', 'Controle de acesso', 'P2', true, false],
  ['intercom', 'Interfonia', 'P2', true, false], ['garage', 'Garagem', 'P2', true, false], ['remote_operations', 'Central remota', 'P3', true, false],
  ['analytics_ai', 'Inteligência', 'P3', true, false],
] as const;
const ON = new Set(['parcels', 'visitors', 'concierge', 'incident']);
type Incident = { id: string; category: string; severity: string; title: string; description: string | null; status: string; resolution: string | null; created_at: string; closed_at: string | null; unit_id: string | null; key: string };
const incidents: Incident[] = [];
const points: { id: string; name: string; kind: string; location: string | null }[] = [
  { id: 'ap-1', name: 'Portão social', kind: 'portao_pedestre', location: 'Entrada principal' }, { id: 'ap-2', name: 'Câmera da guarita', kind: 'camera', location: null }];
let cfg = { pass_default_hours: 24, pass_max_days: 30, pass_max_uses: 5, require_document: false, residents_can_invite: true, notify_resident_on_arrival: true };
type Pass = { id: string; unit_id: string; visitor_name: string; kind: string; notes: string | null; valid_from: string; valid_until: string; uses: number; max_uses: number; status: string; qr: string };
type Visit = { id: string; pass_id: string | null; unit_id: string; visitor_name: string; kind: string; method: string; authorized_by_name: string | null; checked_in_at: string; checked_out_at: string | null; key: string };
const passes: Pass[] = [];
const visits: Visit[] = [];
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const status = (p: Pass) => (p.status === 'revoked' ? 'revoked' : Date.parse(p.valid_until) <= Date.now() ? 'expired' : p.uses >= p.max_uses ? 'used' : 'active');
const mine = (unit: string) => store.user.role !== 'morador' || myUnits().includes(unit);
const seed = () => {
  if (passes.length) return;
  const u = store.s.units[0]?.id, u2 = store.s.units[1]?.id;
  if (!u) return;
  passes.push({ id: crypto.randomUUID(), unit_id: u, visitor_name: 'Paula Fictícia', kind: 'visita', notes: null, valid_from: hours(-1), valid_until: hours(10), uses: 0, max_uses: 1, status: 'active', qr: `PV1.${'d'.repeat(64)}` });
  visits.push({ id: crypto.randomUUID(), pass_id: null, unit_id: u2 || u, visitor_name: 'Técnico da Internet (exemplo)', kind: 'prestador', method: 'manual', authorized_by_name: 'Morador pelo interfone', checked_in_at: hours(-0.5), checked_out_at: null, key: 'seed' });
};

export const MODULE_HANDLERS: Record<string, Handler> = {
  concierge_settings_get: (a) => { tenant(a); return cfg; },
  concierge_settings_save: (a) => { tenant(a); if (store.user.role !== 'admin') fail('Requer permissão de configurações.'); cfg = { ...cfg, ...(typeof a.p_cfg === 'string' ? JSON.parse(a.p_cfg) : a.p_cfg) }; return cfg; },
  visitor_profile_search: (a) => {
    tenant(a); staff(); seed();
    const q = String(a.p_query || '').toLowerCase();
    const seen = new Map<string, any>();
    for (const v of visits) if (!q || v.visitor_name.toLowerCase().includes(q)) {
      const k = v.visitor_name.toLowerCase(); const p = seen.get(k) || { id: `prof-${k}`, full_name: v.visitor_name, kind: v.kind, company: null, document_last4: null, blocked: false, blocked_reason: null, visits: 0, last_visit_at: v.checked_in_at, courier_id: null };
      p.visits++; seen.set(k, p);
    }
    return [...seen.values()];
  },
  visitor_entry: (a) => MODULE_HANDLERS.visitor_check_in({ ...a, p_name: a.p_name }),
  visit_parcel_candidates: (a) => {
    tenant(a); staff();
    const v = visits.find((x) => x.id === a.p_visit) || fail('Visita não encontrada.');
    return store.s.packages.filter((p) => Date.parse(p.received_at) >= Date.parse(v!.checked_in_at) - 2 * 3600_000).slice(0, 20)
      .map((p) => ({ id: p.id, carrier: p.carrier, tracking_code: p.tracking_code, received_at: p.received_at, unit: unitText(p.unit_id), linked: false }));
  },
  visit_link_parcels: (a) => { tenant(a); staff(); return { linked: (a.p_packages || []).length }; },
  incident_list: (a) => { tenant(a); staff(); return incidents.filter((i) => !a.p_status || i.status === a.p_status).map((i) => ({ ...i, unit: unitText(i.unit_id), created_by_name: store.user.full_name })); },
  incident_create: (a) => {
    tenant(a); staff();
    const dup = incidents.find((i) => i.key === a.p_idempotency_key); if (dup) return { id: dup.id, replayed: true };
    if (String(a.p_title || '').trim().length < 3) fail('Categoria, gravidade ou título inválidos.');
    const i = { id: crypto.randomUUID(), category: a.p_category, severity: a.p_severity || 'baixa', title: String(a.p_title).trim(), description: a.p_description || null, status: 'aberta', resolution: null, created_at: nowIso(), closed_at: null, unit_id: a.p_unit || null, key: a.p_idempotency_key };
    incidents.unshift(i); return { id: i.id, replayed: false };
  },
  incident_close: (a) => { tenant(a); staff(); const i = incidents.find((x) => x.id === a.p_incident && x.status === 'aberta') || fail('Ocorrência não encontrada ou já encerrada.'); i!.status = 'encerrada'; i!.resolution = a.p_resolution; i!.closed_at = nowIso(); return { id: i!.id, status: i!.status }; },
  portaria_timeline: (a) => {
    tenant(a); staff(); seed();
    const ev: any[] = [];
    for (const p of store.s.packages) {
      ev.push({ type: 'parcel_received', at: p.received_at, id: p.id, unit: unitText(p.unit_id), title: p.carrier, detail: null });
      if (p.picked_up_at) ev.push({ type: 'parcel_picked_up', at: p.picked_up_at, id: p.id, unit: unitText(p.unit_id), title: p.carrier, detail: p.picked_up_by_name });
    }
    for (const v of visits) {
      ev.push({ type: 'visit_in', at: v.checked_in_at, id: v.id, unit: unitText(v.unit_id), title: v.visitor_name, detail: `${v.kind} · ${v.method}` });
      if (v.checked_out_at) ev.push({ type: 'visit_out', at: v.checked_out_at, id: v.id, unit: unitText(v.unit_id), title: v.visitor_name, detail: v.kind });
    }
    for (const i of incidents) ev.push({ type: 'incident', at: i.created_at, id: i.id, unit: unitText(i.unit_id), title: i.title, detail: `${i.category} · ${i.severity}` });
    return ev.filter((e) => !a.p_unit || e.unit === unitText(a.p_unit)).sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 300);
  },
  access_points_list: (a) => { tenant(a); staff(); return points.map((p) => ({ ...p, status: 'not_installed', device_state: null, homologation: null })); },
  access_point_save: (a) => { tenant(a); if (store.user.role !== 'admin') fail('Requer permissão de configurações.'); const p = { id: a.p_id || crypto.randomUUID(), name: a.p_name, kind: a.p_kind, location: a.p_location || null }; const i = points.findIndex((x) => x.id === p.id); if (i >= 0) points[i] = p; else points.push(p); return { id: p.id }; },
  access_point_delete: (a) => { tenant(a); if (store.user.role !== 'admin') fail('Requer permissão de configurações.'); const i = points.findIndex((x) => x.id === a.p_id); if (i >= 0) points.splice(i, 1); return null; },
  concierge_kpis: (a) => {
    tenant(a); seed();
    return { visits: visits.length, denied: 0, by_kind: {}, by_method: { qr: visits.filter((v) => v.method === 'qr').length, manual: visits.filter((v) => v.method === 'manual').length },
      passes_created: passes.length, open_incidents: incidents.filter((i) => i.status === 'aberta').length, avg_stay_minutes: null };
  },
  tenant_modules: (a) => { tenant(a); return CATALOG.map(([key, name, phase, hw, available]) => ({ key, name, description: '', phase, requires_hardware: hw, available, enabled: ON.has(key), valid_until: null })); },
  visitor_list: (a) => {
    tenant(a); seed();
    const row = <T extends { unit_id: string }>(x: T) => ({ ...x, unit: unitText(x.unit_id) });
    return {
      passes: passes.filter((p) => mine(p.unit_id)).map((p) => { const { qr: _q, ...rest } = row(p); return { ...rest, status: status(p) }; }),
      visits: visits.filter((v) => mine(v.unit_id)).map(row),
    };
  },
  visitor_pass_create: (a) => {
    tenant(a); seed();
    if (!mine(a.p_unit)) fail('Sem permissão para convidar para esta unidade.');
    if (String(a.p_name || '').trim().length < 2) fail('Informe o nome do visitante.');
    const p: Pass = { id: crypto.randomUUID(), unit_id: a.p_unit, visitor_name: String(a.p_name).trim(), kind: a.p_kind || 'visita', notes: a.p_notes || null,
      valid_from: a.p_valid_from || nowIso(), valid_until: a.p_valid_until || hours(24), uses: 0, max_uses: a.p_max_uses || 1, status: 'active',
      qr: `PV1.${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}` };
    if (Date.parse(p.valid_until) <= Date.parse(p.valid_from)) fail('A validade precisa terminar depois do início.');
    passes.unshift(p);
    return { id: p.id, qr: p.qr, valid_from: p.valid_from, valid_until: p.valid_until };
  },
  visitor_pass_revoke: (a) => { tenant(a); const p = passes.find((x) => x.id === a.p_pass) || fail('Convite não encontrado.'); if (!mine(p!.unit_id)) fail('Sem permissão.'); p!.status = 'revoked'; return null; },
  visitor_pass_lookup: (a) => {
    tenant(a); staff(); seed();
    const p = passes.find((x) => x.qr === String(a.p_qr || '').trim()) || fail('Convite não reconhecido neste condomínio.');
    return { ...p, unit: unitText(p!.unit_id), status: Date.parse(p!.valid_from) > Date.now() ? 'not_yet' : status(p!), document_last4: null, qr: undefined };
  },
  visitor_check_in: (a) => {
    tenant(a); staff(); seed();
    const dup = visits.find((v) => v.key === a.p_idempotency_key);
    if (dup) return { id: dup.id, replayed: true, unit_id: dup.unit_id };
    let v: Visit;
    if (a.p_qr) {
      const p = passes.find((x) => x.qr === String(a.p_qr).trim()) || fail('Convite não reconhecido neste condomínio.');
      const s = status(p!);
      if (s !== 'active') fail(s === 'revoked' ? 'Convite revogado pelo morador.' : s === 'expired' ? 'Convite expirado.' : 'Convite já utilizado.');
      p!.uses++;
      v = { id: crypto.randomUUID(), pass_id: p!.id, unit_id: p!.unit_id, visitor_name: p!.visitor_name, kind: p!.kind, method: 'qr', authorized_by_name: null, checked_in_at: nowIso(), checked_out_at: null, key: a.p_idempotency_key };
    } else {
      if (!a.p_unit) fail('Selecione a unidade.');
      if (String(a.p_name || '').trim().length < 2) fail('Informe o nome do visitante.');
      if (String(a.p_authorized_by || '').trim().length < 2) fail('Informe quem autorizou a entrada.');
      v = { id: crypto.randomUUID(), pass_id: null, unit_id: a.p_unit, visitor_name: String(a.p_name).trim(), kind: a.p_kind || 'visita', method: 'manual', authorized_by_name: String(a.p_authorized_by).trim(), checked_in_at: nowIso(), checked_out_at: null, key: a.p_idempotency_key };
    }
    visits.unshift(v);
    return { id: v.id, replayed: false, unit_id: v.unit_id, visitor_name: v.visitor_name, method: v.method };
  },
  visitor_check_out: (a) => { tenant(a); staff(); const v = visits.find((x) => x.id === a.p_visit) || fail('Visita não encontrada.'); v!.checked_out_at ||= nowIso(); return { id: v!.id, checked_out_at: v!.checked_out_at }; },
  concierge_overview: (a) => {
    tenant(a); staff(); seed();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pk = store.s.packages;
    return {
      parcels: { waiting: pk.filter((p) => WAITING.includes(p.status)).length, received_today: pk.filter((p) => Date.parse(p.received_at) >= +today).length,
        picked_today: pk.filter((p) => p.picked_up_at && Date.parse(p.picked_up_at) >= +today).length },
      visitors: { expected_today: passes.filter((p) => status(p) === 'active').length, inside: visits.filter((v) => !v.checked_out_at).length },
      gateways: [{ id: 'demo-gw', name: 'Gateway da portaria (simulador)', kind: 'simulator', status: 'online', last_seen_at: nowIso(), devices: 2 }],
      modules: { visitors: true, cctv: false, access_control: false },
    };
  },
};
