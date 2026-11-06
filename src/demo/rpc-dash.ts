import { STORAGE, nowIso, store, type Pkg } from './store';
import { admin, PENDING, tenant, unitText, WAITING, type Handler } from './rpc';

/** Painel do síndico calculado do mesmo store que a portaria e o morador usam. */
const TZ = 'America/Sao_Paulo';
const ymd = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (s: string, n: number) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const span = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
const h = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3600_000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const avg = (xs: number[]) => (xs.length ? r1(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return r1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const change = (v: number, p: number) => (p ? r1((v - p) / p * 1000) / 1000 : null);
const kpi = (v: number, p: number) => ({ value: v, previous: p, change: change(v, p) });
const ratio = (n: number, d: number) => (d ? n / d : null);
const inDay = (iso: string | null, from: string, to: string) => !!iso && ymd(iso) >= from && ymd(iso) <= to;

function filtered(f: Record<string, string> = {}) {
  return store.s.packages.filter((p) => {
    const u = store.unit(p.unit_id);
    return (!f.block || u?.block === f.block) && (!f.unit || p.unit_id === f.unit) && (!f.carrier || p.carrier === f.carrier)
      && (!f.status || (f.status === 'PENDENTES' ? PENDING.includes(p.status) : p.status === f.status));
  });
}
const used = (id: string) => store.s.packages.filter((p) => WAITING.includes(p.status) && p.storage_location_id === id).length;

function ranking(pk: Pkg[], from: string, to: string, prevFrom: string, prevTo: string) {
  const rec = pk.filter((p) => inDay(p.received_at, from, to));
  const total = rec.length;
  return store.s.units.map((u) => {
    const mine = pk.filter((p) => p.unit_id === u.id);
    const received = mine.filter((p) => inDay(p.received_at, from, to)).length;
    const prev = mine.filter((p) => inDay(p.received_at, prevFrom, prevTo)).length;
    const del = mine.filter((p) => inDay(p.picked_up_at, from, to));
    return { unit_id: u.id, block: u.block, unit: u.label, received, delivered: del.length, pending: mine.filter((p) => WAITING.includes(p.status)).length,
      share: total ? received / total : 0, change: change(received, prev), avg_pickup_h: avg(del.map((p) => h(p.received_at, p.picked_up_at!))) };
  }).filter((r) => r.received || r.delivered || r.pending).sort((a, b) => b.received - a.received || b.pending - a.pending);
}

export const DASH_HANDLERS: Record<string, Handler> = {
  dashboard_operation: (a) => {
    tenant(a); admin();
    const now = nowIso(), today = ymd(now);
    const waiting = store.s.packages.filter((p) => WAITING.includes(p.status));
    const stale = waiting.filter((p) => h(p.received_at, now) > 48).length;
    const locations = STORAGE.filter((s) => s.active).map((s) => ({ id: s.id, code: s.code, rack: s.rack, shelf: s.shelf, used: used(s.id), capacity: s.capacity, is_contingency: s.is_contingency }));
    const events = store.s.packages.flatMap((p) => [{ id: p.id, kind: 'received', unit: unitText(p.unit_id), carrier: p.carrier, at: p.received_at },
      ...(p.picked_up_at ? [{ id: p.id, kind: 'picked', unit: unitText(p.unit_id), carrier: p.carrier, at: p.picked_up_at }] : [])]);
    return {
      waiting_now: waiting.length, unstored_now: 0, stale_hours: 48, stale_now: stale, timezone: TZ, as_of: now,
      received_today: store.s.packages.filter((p) => ymd(p.received_at) === today).length,
      picked_today: store.s.packages.filter((p) => p.picked_up_at && ymd(p.picked_up_at) === today).length,
      attention: { access_requests: store.s.requests.filter((r) => r.status === 'pending').length, stale_packages: stale,
        near_capacity: locations.filter((l) => l.used / l.capacity >= 0.8).length, notification_failures: 0, receipt_failures: 0,
        preregistered: store.s.packages.filter((p) => p.status === 'PRE_REGISTRADA').length },
      occupancy: { used: locations.reduce((s, l) => s + l.used, 0), capacity: locations.reduce((s, l) => s + l.capacity, 0) },
      locations, recent: events.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 8),
    };
  },
  dashboard_executive: (a) => {
    tenant(a); admin();
    const now = nowIso(), from: string = a.p_from, to: string = a.p_to, f = a.p_filters || {};
    const len = span(from, to) + 1, prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(len - 1));
    const pk = filtered(f);
    const rec = pk.filter((p) => inDay(p.received_at, from, to)), recPrev = pk.filter((p) => inDay(p.received_at, prevFrom, prevTo));
    const del = pk.filter((p) => inDay(p.picked_up_at, from, to)), delPrev = pk.filter((p) => inDay(p.picked_up_at, prevFrom, prevTo));
    const wait = (xs: Pkg[]) => xs.map((p) => h(p.received_at, p.picked_up_at!));
    const within = (xs: Pkg[], lim: number) => ratio(wait(xs).filter((x) => x <= lim).length, xs.length);
    const pending = pk.filter((p) => WAITING.includes(p.status));
    const age = pending.map((p) => h(p.received_at, now));
    const blocks = [...rec.reduce((m, p) => { const b = store.unit(p.unit_id)?.block || '—'; return m.set(b, (m.get(b) || 0) + 1); }, new Map<string, number>())]
      .map(([block, received]) => ({ block, received })).sort((x, y) => y.received - x.received);
    const rank = ranking(pk, from, to, prevFrom, prevTo);
    const top = rank.slice(0, 3);
    const heat = new Map<string, { dow: number; hour: number; n: number }>();
    for (const p of rec) {
      const d = new Date(p.received_at), parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
      const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find((x) => x.type === 'weekday')!.value) + 1;
      const hour = Number(parts.find((x) => x.type === 'hour')!.value);
      const k = `${dow}-${hour}`; heat.set(k, { dow, hour, n: (heat.get(k)?.n || 0) + 1 });
    }
    const series = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      series.push({ start: d, end: d, received: rec.filter((p) => ymd(p.received_at) === d).length, delivered: del.filter((p) => ymd(p.picked_up_at!) === d).length,
        balance: pk.filter((p) => ymd(p.received_at) <= d && !(p.picked_up_at && ymd(p.picked_up_at) <= d) && !(p.resolved_at && ymd(p.resolved_at) <= d)).length });
    }
    const cohortPicked = rec.filter((p) => p.picked_up_at).length;
    const count = (xs: string[]) => [...xs.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map<string, number>())];
    const unitsMoved = (xs: Pkg[]) => new Set(xs.map((p) => p.unit_id)).size;
    return {
      from, to, previous: { from: prevFrom, to: prevTo }, filters: f, timezone: TZ, as_of: now, granularity: 'day',
      received: kpi(rec.length, recPrev.length), delivered: kpi(del.length, delPrev.length), units_moved: kpi(unitsMoved(rec), unitsMoved(recPrev)),
      cohort: { rate: ratio(cohortPicked, rec.length), received: rec.length, picked: cohortPicked },
      pending_now: pending.length, overdue_now: age.filter((x) => x > 72).length, overdue_hours: 72,
      pickup_time: { avg_h: avg(wait(del)), median_h: median(wait(del)), avg_h_previous: avg(wait(delPrev)),
        change: (() => { const x = avg(wait(del)), y = avg(wait(delPrev)); return x != null && y ? change(x, y) : null; })(), n: del.length },
      efficiency: { within_24h: within(del, 24), within_48h: within(del, 48), within_48h_previous: within(delPrev, 48),
        receipt_to_notice: { median_h: median(rec.filter((p) => p.notified_at).map((p) => h(p.received_at, p.notified_at!))), n: rec.length, without_notice: rec.filter((p) => !p.notified_at).length },
        notice_to_pickup: { median_h: median(del.filter((p) => p.notified_at).map((p) => h(p.notified_at!, p.picked_up_at!))), n: del.length } },
      blocks, concentration: { top_units: top.length, top_received: top.reduce((s, r) => s + r.received, 0), total_received: rec.length },
      heatmap: [...heat.values()], series,
      options: { blocks: [...new Set(store.s.units.map((u) => u.block).filter(Boolean))].sort(), units: store.s.units.map((u) => ({ id: u.id, block: u.block, label: u.label })),
        statuses: ['PENDENTES', 'RETIRADA', 'DEVOLVIDA', 'CANCELADA', 'EXTRAVIADA'], carriers: [...new Set(store.s.packages.map((p) => p.carrier))].sort() },
      recipients: { reason: 'Disponível só com dados reais.' },
      aging_now: { lt24: age.filter((x) => x < 24).length, h24_48: age.filter((x) => x >= 24 && x < 48).length, h48_72: age.filter((x) => x >= 48 && x < 72).length, gt72: age.filter((x) => x >= 72).length },
      oldest_waiting: pending.sort((x, y) => x.received_at.localeCompare(y.received_at)).slice(0, 5).map((p) => ({ block: store.unit(p.unit_id)?.block ?? null,
        unit: store.unit(p.unit_id)?.label ?? null, received_at: p.received_at, hours: r1(h(p.received_at, now)), status: p.status })),
      adoption: { units_with_resident: new Set(store.s.memberships.filter((m) => m.role === 'morador' && m.status === 'active').map((m) => m.unit_id)).size,
        units_active: store.s.units.filter((u) => u.active).length },
      carriers: count(rec.map((p) => p.carrier)).map(([carrier, n]) => ({ carrier, n })).sort((x, y) => y.n - x.n),
      exceptions: count(pk.filter((p) => inDay(p.resolved_at, from, to)).map((p) => p.status)).map(([status, n]) => ({ status, n })),
      channels: [{ channel: 'email', state: 'accepted', n: store.s.notifications.filter((n) => inDay(n.created_at, from, to)).length }].filter((c) => c.n),
    };
  },
  dashboard_unit_ranking: (a) => {
    tenant(a); admin();
    const from: string = a.p_from, to: string = a.p_to, len = span(from, to) + 1, prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(len - 1));
    const pk = filtered(a.p_filters || {});
    const all = ranking(pk, from, to, prevFrom, prevTo);
    const off = a.p_offset || 0;
    return { items: all.slice(off, off + (a.p_limit || 10)), total: all.length, offset: off, received_total: all.reduce((s, r) => s + r.received, 0) };
  },
};
