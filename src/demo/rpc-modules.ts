import { nowIso, store } from './store';
import { fail, myUnits, staff, tenant, unitText, WAITING, type Handler } from './rpc';

/**
 * Módulos novos na /demonstracao (mesmos nomes de RPC das migrations 20261118000100/0200): Visitantes e Central
 * ligados para mostrar o fluxo; dados fictícios em memória. Gateway: um simulador "online" claramente marcado.
 */
const CATALOG = [
  ['parcels', 'Encomendas', 'P0', false, true], ['visitors', 'Visitantes', 'P0', false, true], ['concierge', 'Portaria', 'P0', false, true],
  ['incident', 'Ocorrências', 'P1', false, false], ['cctv', 'Câmeras', 'P1', true, false], ['access_control', 'Controle de acesso', 'P2', true, false],
  ['intercom', 'Interfonia', 'P2', true, false], ['garage', 'Garagem', 'P2', true, false], ['remote_operations', 'Central remota', 'P3', true, false],
  ['analytics_ai', 'Inteligência', 'P3', true, false],
] as const;
const ON = new Set(['parcels', 'visitors', 'concierge']);
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
