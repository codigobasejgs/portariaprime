import { TENANT } from './mode';
import { nowIso, store, type User } from './store';
import { admin, fail, pkgRow, PENDING, staff, tenant, unitText, type Handler } from './rpc';

/** Síndico: pessoas, unidades e relatórios. */
const memberUnits = (userId: string) => store.s.memberships.filter((m) => m.user_id === userId && m.unit_id)
  .map((m) => { const u = store.unit(m.unit_id)!; return { unit_id: u.id, block: u.block, label: u.label, status: m.status }; });
const userOf = (id: string) => store.s.users.find((u) => u.id === id) || fail('Morador não encontrado.');
const reqOf = (id: string) => store.s.requests.find((r) => r.id === id) || fail('Solicitação não encontrada.');
const invOf = (id: string) => store.s.invitations.find((i) => i.id === id) || fail('Convite não encontrado.');
const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();

function addUnits(rows: { block: string | null; label: string }[], dry: boolean) {
  const errors: { line: number; error: string }[] = [];
  const seen = new Set(store.s.units.map((u) => `${norm(u.block)}|${norm(u.label)}`));
  const ok: { block: string | null; label: string }[] = [];
  rows.forEach((r, i) => {
    const k = `${norm(r.block)}|${norm(r.label)}`;
    if (!String(r.label || '').trim()) errors.push({ line: i + 1, error: 'Unidade vazia.' });
    else if (seen.has(k)) errors.push({ line: i + 1, error: 'Unidade já cadastrada.' });
    else { seen.add(k); ok.push({ block: r.block ? String(r.block).trim() : null, label: String(r.label).trim() }); }
  });
  if (store.s.units.length + ok.length > 50) errors.push({ line: 0, error: 'Limite de 50 unidades na demonstração.' });
  if (!dry && !errors.length) {
    for (const r of ok) store.s.units.push({ id: crypto.randomUUID(), tenant_id: TENANT, ...r, active: true });
    store.changed('units');
  }
  return { valid: !errors.length, errors, preview: ok, count: ok.length, written: dry || errors.length ? 0 : ok.length };
}

function reportPkgs(f: Record<string, string>) {
  const q = (f.search || '').toLowerCase(), rec = (f.recipient || '').toLowerCase();
  const st = f.status === 'PENDENTES' ? PENDING : f.status ? [f.status] : null;
  const d = (x: string, end = false) => new Date(`${x}T${end ? '23:59:59.999' : '00:00:00'}-03:00`).toISOString();
  return store.s.packages.filter((p) => {
    const u = store.unit(p.unit_id);
    return (!f.block || norm(u?.block) === norm(f.block)) && (!f.unit || p.unit_id === f.unit) && (!f.carrier || p.carrier === f.carrier) && (!st || st.includes(p.status))
      && (!f.received_from || p.received_at >= d(f.received_from)) && (!f.received_to || p.received_at <= d(f.received_to, true))
      && (!f.picked_from || (p.picked_up_at || '') >= d(f.picked_from)) && (!f.picked_to || (p.picked_up_at && p.picked_up_at <= d(f.picked_to, true)))
      && (!f.operator || p.delivered_by === f.operator) && (!f.registered_via || p.registered_via === f.registered_via)
      && (!rec || (p.recipient_name || '').toLowerCase().includes(rec))
      && (!q || `${unitText(p.unit_id)} ${p.tracking_code || ''} ${p.recipient_name || ''} ${p.carrier} ${p.ref}`.toLowerCase().includes(q));
  }).sort((a, b) => b.received_at.localeCompare(a.received_at) || b.id.localeCompare(a.id));
}
const hoursBetween = (a: string, b: string) => Math.round(((Date.parse(b) - Date.parse(a)) / 3600_000) * 10) / 10;

export const ADMIN_HANDLERS: Record<string, Handler> = {
  list_members: (a) => {
    tenant(a); staff();
    return store.s.users.map((u) => {
      const ms = store.s.memberships.filter((m) => m.user_id === u.id);
      if (!ms.length) return null;
      const m = ms.find((x) => x.status === 'active') || ms[0];
      return { membership_id: m.id, user_id: u.id, role: u.role, status: m.status, full_name: u.full_name, email: u.email, permissions: u.permissions, units: memberUnits(u.id) };
    }).filter(Boolean);
  },
  set_membership_status: (a) => {
    admin();
    const m = store.s.memberships.find((x) => x.id === a.p_membership) || fail('Vínculo não encontrado.');
    if (m.user_id === store.userId) fail('Você não pode alterar o próprio acesso.');
    m.status = a.p_status; store.changed('members'); return null;
  },
  list_access_requests: (a) => {
    tenant(a); admin();
    return store.s.requests.filter((r) => !a.p_status || r.status === a.p_status).sort((x, y) => y.created_at.localeCompare(x.created_at)).map((r) => ({ ...r }));
  },
  decide_access_request: (a) => {
    admin();
    const r = reqOf(a.p_request);
    if (r.status !== 'pending') fail('Solicitação já decidida.');
    r.decided_at = nowIso();
    if (!a.p_approve) {
      if (String(a.p_reason || '').trim().length < 3) fail('Informe o motivo.');
      r.status = 'rejected'; r.reason = a.p_reason; store.changed('requests'); return null;
    }
    const unit = a.p_unit || r.unit_id;
    if (!store.unit(unit)?.active) fail('Escolha a unidade do morador.');
    let u = store.s.users.find((x) => x.email === r.email);
    if (!u) {
      u = { id: crypto.randomUUID(), email: r.email, full_name: r.full_name, role: 'morador', permissions: [], contact_phone: r.phone, contact_email: r.email } as User;
      store.s.users.push(u);
    }
    store.s.memberships.push({ id: crypto.randomUUID(), user_id: u.id, role: 'morador', status: 'active', unit_id: unit, relation: r.relation, since: nowIso() });
    store.s.contacts.push({ id: crypto.randomUUID(), user_id: u.id, unit_id: unit, name: u.full_name, phone: r.phone, email: r.email, notify_whatsapp: false, notify_email: true, active: true });
    r.status = 'approved'; r.unit_id = unit;
    store.changed('requests');
    return null;
  },
  access_request_cancel: (a) => { admin(); const r = reqOf(a.p_request); r.status = 'cancelled'; r.decided_at = nowIso(); store.changed('requests'); return null; },
  access_request_admin_update: (a) => {
    admin();
    const r = reqOf(a.p_request);
    if (r.status !== 'pending') fail('Só solicitações pendentes podem ser editadas.');
    if (String(a.p_full_name || '').trim().length < 2) fail('Informe o nome.');
    Object.assign(r, { full_name: a.p_full_name.trim(), phone: a.p_phone, block_text: a.p_block, unit_text: a.p_unit_text, unit_id: a.p_unit });
    store.changed('requests'); return null;
  },
  revoke_invitation: (a) => { admin(); invOf(a.p_invitation).revoked_at = nowIso(); store.changed('invitations'); return null; },
  invitation_update: (a) => { admin(); if (!store.unit(a.p_unit)) fail('Unidade inválida.'); invOf(a.p_invitation).unit_id = a.p_unit; store.changed('invitations'); return null; },

  resident_admin_get: (a) => {
    tenant(a); admin();
    const u = userOf(a.p_user);
    const ms = store.s.memberships.filter((m) => m.user_id === u.id && m.role === 'morador');
    if (!ms.length) fail('Morador não encontrado.');
    const c = store.s.contacts.find((x) => x.user_id === u.id && x.active);
    return { full_name: u.full_name, contact_phone: c?.phone ?? u.contact_phone, contact_email: c?.email ?? u.contact_email, login_email: u.email, shared_account: false,
      status: (ms.find((m) => m.status === 'active') || ms[0]).status, units: memberUnits(u.id), pending_request: false };
  },
  resident_update: (a) => {
    tenant(a); admin();
    const u = userOf(a.p_user);
    if (String(a.p_full_name || '').trim().length < 2) fail('Informe o nome.');
    if (a.p_unit && !store.unit(a.p_unit)) fail('Unidade inválida.');
    u.full_name = a.p_full_name.trim(); u.contact_phone = a.p_phone; u.contact_email = a.p_email;
    const m = store.s.memberships.find((x) => x.user_id === u.id && x.unit_id === (a.p_from_unit || a.p_unit)) || store.s.memberships.find((x) => x.user_id === u.id && x.role === 'morador');
    if (m) { if (a.p_unit) m.unit_id = a.p_unit; m.status = a.p_status || m.status; }
    for (const c of store.s.contacts.filter((x) => x.user_id === u.id)) Object.assign(c, { name: u.full_name, phone: a.p_phone, email: a.p_email, unit_id: m?.unit_id ?? c.unit_id });
    store.changed('members');
    return null;
  },
  resident_delete: (a) => {
    tenant(a); admin();
    const u = userOf(a.p_user);
    if (u.role !== 'morador') fail('Só cadastros de morador podem ser excluídos aqui.');
    store.s.memberships = store.s.memberships.filter((m) => m.user_id !== u.id);
    store.s.contacts = store.s.contacts.filter((c) => c.user_id !== u.id);
    store.s.notifications = store.s.notifications.filter((n) => n.user_id !== u.id);
    for (const r of store.s.requests) if (r.email === u.email && r.status === 'pending') r.status = 'cancelled';
    store.changed('members');
    return null;
  },

  units_generate: (a) => {
    tenant(a); admin();
    const s = a.p_spec || {}, blocks: (string | null)[] = s.blocks?.length ? s.blocks : [null];
    const rows: { block: string | null; label: string }[] = [];
    const n = (v: unknown) => Math.trunc(Number(v));
    if (s.mode === 'floors') {
      for (const b of blocks) for (let f = n(s.floor_from); f <= n(s.floor_to); f++) for (let i = 1; i <= n(s.per_floor); i++) rows.push({ block: b, label: `${s.prefix || ''}${f}${String(i).padStart(2, '0')}` });
    } else for (const b of blocks) for (let i = n(s.from); i <= n(s.to); i++) rows.push({ block: b, label: `${s.prefix || ''}${i}` });
    if (rows.length > 60) return { valid: false, errors: [{ line: 0, error: 'Limite de 50 unidades na demonstração.' }], preview: [], count: rows.length };
    return addUnits(rows, !!a.p_dry_run);
  },
  import_units: (a) => { tenant(a); admin(); return addUnits(a.p_rows || [], !!a.p_dry_run); },

  report_filter_options: (a) => {
    tenant(a); admin();
    return { blocks: [...new Set(store.s.units.map((u) => u.block).filter(Boolean) as string[])].sort(),
      units: store.s.units.map((u) => ({ id: u.id, block: u.block, label: u.label })),
      carriers: [...new Set(store.s.packages.map((p) => p.carrier))].sort(),
      operators: store.s.users.filter((u) => u.role !== 'morador').map((u) => ({ id: u.id, name: u.full_name, role: u.role })) };
  },
  report_packages: (a) => {
    tenant(a); admin();
    const c = a.p_cursor_at;
    return reportPkgs(a.p_filters || {}).filter((p) => !c || p.received_at < c || (p.received_at === c && p.id < a.p_cursor_id)).slice(0, a.p_limit || 100).map((p) => {
      const r = pkgRow(p);
      return { id: p.id, unit_block: r.unit_block, unit_label: r.unit_label, carrier: p.carrier, tracking_code: p.tracking_code,
        protocol: store.s.receipts.find((x) => x.package_id === p.id)?.protocol ?? null, recipient_name: p.recipient_name, status: p.status, received_at: p.received_at,
        received_by_name: p.received_by_name, picked_up_at: p.picked_up_at, picked_up_by_name: p.picked_up_by_name,
        delivered_by_name: store.s.users.find((u) => u.id === p.delivered_by)?.full_name ?? null,
        hours_waiting: hoursBetween(p.received_at, p.picked_up_at || nowIso()), registered_via: p.registered_via, resolution_reason: p.resolution_reason };
    });
  },
  report_packages_summary: (a) => {
    tenant(a); admin();
    const rows = reportPkgs(a.p_filters || {});
    const picked = rows.filter((p) => p.picked_up_at);
    const count = (key: (p: (typeof rows)[number]) => string) => [...rows.reduce((m, p) => m.set(key(p), (m.get(key(p)) || 0) + 1), new Map<string, number>())]
      .map(([k, n]) => ({ k, n })).sort((x, y) => y.n - x.n);
    return { total: rows.length, pending: rows.filter((p) => PENDING.includes(p.status)).length, picked: picked.length,
      exceptions: rows.filter((p) => ['DEVOLVIDA', 'CANCELADA', 'EXTRAVIADA'].includes(p.status)).length,
      avg_pickup_h: picked.length ? Math.round(picked.reduce((s, p) => s + hoursBetween(p.received_at, p.picked_up_at!), 0) / picked.length * 10) / 10 : null,
      by_carrier: count((p) => p.carrier).map(({ k, n }) => ({ carrier: k, n })), top_units: count((p) => unitText(p.unit_id) || '—').slice(0, 10).map(({ k, n }) => ({ unit: k, n })) };
  },
  report_residents: (a) => {
    tenant(a); admin();
    const f = a.p_filters || {}, q = (f.search || '').toLowerCase();
    const out: any[] = [];
    for (const u of store.s.units) {
      if ((f.block && norm(u.block) !== norm(f.block)) || (f.unit && u.id !== f.unit)) continue;
      const ms = store.s.memberships.filter((m) => m.unit_id === u.id && m.role === 'morador');
      const occupied = ms.some((m) => m.status === 'active');
      if ((f.occupancy === 'with' && !occupied) || (f.occupancy === 'without' && ms.length)) continue;
      const base = { unit_id: u.id, block: u.block, label: u.label, unit_active: u.active };
      if (!ms.length) { if (!f.status && !f.relation && !q) out.push({ ...base, user_id: null, full_name: null, relation: null, status: null, email: null, phone: null, since: null }); continue; }
      for (const m of ms) {
        const p = store.s.users.find((x) => x.id === m.user_id)!;
        if ((f.status && m.status !== f.status) || (f.relation && m.relation !== f.relation) || (q && !`${p.full_name} ${p.email}`.toLowerCase().includes(q))) continue;
        out.push({ ...base, user_id: p.id, full_name: p.full_name, relation: m.relation, status: m.status, email: p.contact_email || p.email, phone: p.contact_phone, since: m.since });
      }
    }
    return out;
  },
};
