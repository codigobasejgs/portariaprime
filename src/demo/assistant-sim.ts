import { TENANT } from './mode';
import { nowIso, store } from './store';
import { HANDLERS, WAITING } from './rpc';
import type { Level } from '../../api/_lib/assistant-text';
import type { Link, Svc } from '../../api/_lib/assistant-core';

/**
 * Banco simulado do Portaria Prime IA na /demonstracao: as mesmas RPCs do webhook (assistant_read/propose/confirm/cancel),
 * respondidas com os handlers da demonstração. O motor de conversa é o MESMO do servidor (api/_lib/assistant-core).
 * Executa como a síndica fictícia; o nível escolhido no simulador é conferido aqui como no banco real.
 */
const RANK: Record<Level, number> = { basic: 1, intermediate: 2, advanced: 3 };
const NEED: Record<string, Level> = { receive_package: 'advanced', register_courier: 'advanced' };
const pending = new Map<string, { action: string; params: any; summary: string; status: string; expires: number }>();
const ref = (id: string) => id.replace(/-/g, '').slice(0, 6).toUpperCase();
const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
const call = (fn: string, args: Record<string, unknown>) => HANDLERS[fn]({ p_tenant: TENANT, ...args });
const unitOf = (id: string | null) => { const u = store.unit(id); return u ? [u.block, u.label].filter(Boolean).join(' ') : ''; };
const plain = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/^(BLOCO|BL|TORRE|APTO|APARTAMENTO|AP|UNIDADE)\s*/, '').trim();

export function demoLink(level: Level): Link {
  return { link_id: 'demo', tenant_id: TENANT, tenant_name: 'Jardins Prime (demonstração)', level, role: 'admin', can_approve: true, is_admin: true,
    full_name: 'Carla Mendes', timezone: 'America/Sao_Paulo', feature_ocr: true };
}

function read(kind: string, a: any): any {
  const waiting = store.s.packages.filter((p) => WAITING.includes(p.status));
  if (kind === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    return { waiting: waiting.length, overdue_7d: waiting.filter((p) => days(p.received_at) >= 7).length, overdue_72h: waiting.filter((p) => days(p.received_at) >= 3).length,
      rejected: waiting.filter((p) => p.rejected_at).length, unidentified: waiting.filter((p) => p.unidentified_reason).length,
      received_today: store.s.packages.filter((p) => p.received_at.startsWith(today)).length, picked_today: store.s.packages.filter((p) => p.picked_up_at?.startsWith(today)).length,
      access_requests: call('access_requests_pending_count', {}), keywords: call('list_delivery_keywords', {}).length,
      oldest: [...waiting].sort((x, y) => x.received_at.localeCompare(y.received_at)).slice(0, 5)
        .map((p) => ({ ref: ref(p.id), unit: unitOf(p.unit_id), carrier: p.carrier, recipient: p.recipient_name, days: days(p.received_at) })) };
  }
  if (kind === 'pending_by_unit') {
    return waiting.filter((p) => { const u = store.unit(p.unit_id); return (!a.block || plain(u?.block) === plain(a.block)) && (!a.unit || plain(u?.label) === plain(a.unit)); })
      .sort((x, y) => x.received_at.localeCompare(y.received_at)).slice(0, 15)
      .map((p) => ({ id: p.id, ref: ref(p.id), unit: unitOf(p.unit_id), carrier: p.carrier, recipient: p.recipient_name, days: days(p.received_at), rejected: !!p.rejected_at }));
  }
  if (kind === 'access_requests') return call('list_access_requests', { p_status: 'pending' }).slice(0, 10)
    .map((r: any) => ({ id: r.id, name: r.full_name, unit: [r.block_text, r.unit_text].filter(Boolean).join(' '), unit_id: r.unit_id, relation: r.relation }));
  if (kind === 'unidentified') return call('list_unidentified_packages', {}).slice(0, 10)
    .map((p: any) => ({ id: p.id, ref: ref(p.id), unit: [p.unit_block, p.unit_label].filter(Boolean).join(' '), carrier: p.carrier, recipient: p.recipient_name }));
  if (kind === 'keywords') return call('list_delivery_keywords', {}).slice(0, 10)
    .map((k: any) => ({ id: k.id, keyword: k.keyword, unit: [k.unit_block, k.unit_label].filter(Boolean).join(' '), carrier: k.carrier }));
  if (kind === 'unit_lookup') return store.s.units.filter((u) => u.active && (!a.block || plain(u.block) === plain(a.block)) && plain(u.label) === plain(a.unit)).slice(0, 5)
    .map((u) => ({ id: u.id, unit: [u.block, u.label].filter(Boolean).join(' '), residents: call('unit_residents_for_staff', { p_unit: u.id }) }));
  if (kind === 'report') {
    const span = { today: 0, month: 29, '3m': 89, '6m': 179, year: 364 }[a.period as string];
    if (span === undefined) throw new Error('Período inválido.');
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - span * 86400_000).toISOString().slice(0, 10);
    const r = call('dashboard_executive', { p_from: from, p_to: to, p_filters: {} });
    const inPeriod = store.s.packages.filter((p) => p.received_at.slice(0, 10) >= from && p.status !== 'PRE_REGISTRADA');
    const porters = [...inPeriod.reduce((m, p) => m.set(p.received_by_name || 'Sem nome', (m.get(p.received_by_name || 'Sem nome') || 0) + 1), new Map<string, number>())]
      .map(([name, n]) => ({ name, n })).sort((x, y) => y.n - x.n).slice(0, 5);
    return { from, to, received: r.received.value, delivered: r.delivered.value, pending_now: r.pending_now, overdue_now: r.overdue_now, avg_pickup_h: r.pickup_time?.avg_h ?? null,
      carriers: r.carriers, occupancy: call('dashboard_operation', { p_stale_hours: 72 }).occupancy, porters,
      rejected: inPeriod.filter((p) => p.rejected_at).length, unidentified: inPeriod.filter((p) => p.unidentified_reason).length,
      couriers: new Set(inPeriod.map((p) => (p.courier_name || '').trim().toLowerCase()).filter(Boolean)).size };
  }
  if (kind === 'match_label') return { status: 'matched', unit_id: store.s.units[0]?.id };
  if (kind === 'consume_ocr') return true;
  throw new Error('Consulta desconhecida.');
}

function execute(action: string, a: any) {
  if (action === 'approve_resident') return call('decide_access_request', { p_request: a.request_id, p_approve: true, p_unit: a.unit_id, p_reason: null });
  if (action === 'destinate_package') return call('package_destinate', { p_package: a.package_id, p_unit: a.unit_id, p_recipient: a.recipient, p_resident_user: null });
  if (action === 'return_package') return call('resolve_package', { p_package: a.package_id, p_status: 'DEVOLVIDA', p_reason: a.reason });
  if (action === 'keyword_used') return call('delivery_keyword_mark_used', { p_id: a.keyword_id });
  if (action === 'receive_package') return call('receive_and_store', { p_idempotency_key: `wa-${crypto.randomUUID()}`, p_unit: a.unit_id, p_tracking: a.tracking, p_carrier: a.carrier,
    p_recipient: a.recipient, p_notes: 'Registrada pelo assistente no WhatsApp.', p_storage_location: a.storage_location_id, p_courier: a.courier, p_received_by_name: a.received_by });
  throw new Error('Ação indisponível na demonstração.');
}

/** Cliente "Supabase" do simulador. Erros viram { error } como no PostgREST. */
export function demoSvc(level: Level): Svc {
  const wrap = (fn: () => any) => { try { return Promise.resolve({ data: fn(), error: null }); } catch (e: any) { return Promise.resolve({ data: null, error: { message: e?.message || 'Falha.' } }); } };
  return {
    rpc: (fn, a: any = {}) => wrap(() => {
      if (fn === 'assistant_read') return read(a.p_kind, a.p_args || {});
      if (fn === 'assistant_storage') return { id: null, name: 'Portaria principal › Estante A' };
      if (fn === 'assistant_propose') {
        const need = NEED[a.p_action] || 'intermediate';
        if (RANK[level] < RANK[need]) throw new Error('Seu nível no assistente não permite esta ação.');
        for (const p of pending.values()) if (p.status === 'pending') p.status = 'cancelled';
        const id = crypto.randomUUID();
        pending.set(id, { action: a.p_action, params: a.p_params, summary: a.p_summary, status: 'pending', expires: Date.now() + 10 * 60_000 });
        return { id, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() };
      }
      if (fn === 'assistant_cancel') { const p = pending.get(a.p_pending); if (p?.status === 'pending') p.status = 'cancelled'; return { cancelled: true }; }
      if (fn === 'assistant_confirm') {
        const p = pending.get(a.p_pending);
        if (!p) throw new Error('Ação não encontrada.');
        if (p.status === 'done') return { status: 'done', replayed: true };
        if (p.status !== 'pending') return { status: p.status };
        if (p.expires < Date.now()) { p.status = 'expired'; return { status: 'expired' }; }
        try { const result = execute(p.action, p.params); p.status = 'done'; store.changed('packages'); return { status: 'done', result }; }
        catch (e: any) { p.status = 'failed'; return { status: 'failed', error: e?.message }; }
      }
      throw new Error(`Função ${fn} indisponível na demonstração.`);
    }),
    from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: () => Promise.resolve({ data: { action: pending.get(id)?.action } }) }) }) }),
  };
}

export { nowIso };
