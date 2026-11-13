import { TENANT } from './mode';
import { CONCIERGE, STORAGE, nowIso, receiptFor, store, type Pkg } from './store';
import { ADMIN_HANDLERS } from './rpc-admin';
import { DASH_HANDLERS } from './rpc-dash';
import { PORTARIA_HANDLERS } from './rpc-portaria';
import { COURIER_HANDLERS } from './rpc-couriers';
import { IMPORT_HANDLERS } from './rpc-import';
import { ASSISTANT_HANDLERS } from './rpc-assistant';

/** Same RPC names and parameter names the pages send to Supabase; data from the local store. */
export type Handler = (a: Record<string, any>) => any;

export const WAITING = ['RECEBIDA', 'ARMAZENADA'];
export const PENDING = [...WAITING, 'PRE_REGISTRADA'];
export const fail = (m: string): never => { throw new Error(m); };
export const tenant = (a: Record<string, any>) => { if (a.p_tenant && a.p_tenant !== TENANT) fail('Condomínio indisponível.'); };
export const staff = () => { if (store.user.role === 'morador') fail('Sem permissão.'); };
export const admin = () => { if (store.user.role !== 'admin') fail('Sem permissão.'); };
export const myUnits = () => store.s.memberships.filter((m) => m.user_id === store.userId && m.role === 'morador' && m.status === 'active').map((m) => m.unit_id!);
export const unitText = (id: string | null) => { const u = store.unit(id); return u ? `${u.block ? `${u.block}-` : ''}${u.label}` : null; };
const loc = (id: string | null) => STORAGE.find((s) => s.id === id);

export function pkgRow(p: Pkg) {
  const u = store.unit(p.unit_id), l = loc(p.storage_location_id);
  return {
    id: p.id, status: p.status, tracking_code: p.tracking_code, carrier: p.carrier, recipient_name: p.recipient_name, notes: p.notes, registered_via: p.registered_via,
    unit_id: p.unit_id, unit_block: u?.block ?? null, unit_label: u?.label ?? null, storage_location_id: p.storage_location_id, storage_code: l?.code ?? null,
    received_at: p.received_at, stored_at: p.stored_at, notified_at: p.notified_at, picked_up_at: p.picked_up_at, picked_up_by_name: p.picked_up_by_name,
    pickup_method: p.pickup_method, resolution_reason: p.resolution_reason, courier_name: p.courier_name, received_by_name: p.received_by_name,
    unidentified_reason: p.unidentified_reason ?? null, rejected_at: p.rejected_at ?? null, rejection_reason: p.rejection_reason ?? null, rejection_note: p.rejection_note ?? null,
  };
}
const byRecent = (a: Pkg, b: Pkg) => b.received_at.localeCompare(a.received_at) || b.id.localeCompare(a.id);
const cursor = (a: Record<string, any>) => (p: Pkg) => !a.p_cursor_at || p.received_at < a.p_cursor_at || (p.received_at === a.p_cursor_at && p.id < a.p_cursor_id);
const dayStart = (d: string) => new Date(`${d}T00:00:00-03:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999-03:00`).toISOString();

function residentPkg(p: Pkg) {
  const r = store.s.receipts.find((x) => x.package_id === p.id);
  const timeline = [{ kind: 'received', at: p.received_at }, p.stored_at && { kind: 'stored', at: p.stored_at },
    p.picked_up_at && { kind: 'picked_up', at: p.picked_up_at }, p.resolved_at && { kind: p.status.toLowerCase(), at: p.resolved_at }].filter(Boolean);
  return { ...pkgRow(p), ref: p.ref, resolved_at: p.resolved_at, concierge_name: CONCIERGE[0].name,
    receipt: r ? { protocol: r.protocol, pdf_status: 'ready' } : null, timeline };
}
const mine = (id: string) => {
  const p = store.pkg(id);
  if (!p || (store.user.role === 'morador' && !myUnits().includes(p.unit_id!))) fail('Encomenda não encontrada.');
  return p!;
};

function newPackage(a: Record<string, any>, status: string): Pkg {
  const p: Pkg = {
    id: crypto.randomUUID(), ref: `JP-${++store.s.seq}`, status, carrier: a.p_carrier || 'Outra', tracking_code: a.p_tracking || null, recipient_name: a.p_recipient || null,
    notes: a.p_notes || null, unit_id: a.p_unit, received_at: nowIso(), stored_at: status === 'ARMAZENADA' ? nowIso() : null, notified_at: nowIso(), picked_up_at: null,
    picked_up_by_name: null, pickup_method: null, delivered_by: null, resolution_reason: null, resolved_at: null, storage_location_id: a.p_storage_location || null,
    courier_name: a.p_courier || null, received_by_name: a.p_received_by_name || null, registered_via: 'portaria', idempotency_key: a.p_idempotency_key,
  };
  return p;
}
function freeSlot() {
  const used = (id: string) => store.s.packages.filter((p) => WAITING.includes(p.status) && p.storage_location_id === id).length;
  return STORAGE.filter((s) => s.active).sort((x, y) => Number(x.is_contingency) - Number(y.is_contingency) || x.sort_order - y.sort_order).find((s) => used(s.id) < s.capacity);
}

/** Estado da assinatura fictícia: o síndico "assina" pelo botão; a Contratada assina logo depois. */
export const DEMO_SIG = { contractor: null as string | null, owner: null as string | null };
export function demoSignature() {
  const s = DEMO_SIG;
  return { acceptance_id: '00000000-0000-4000-8000-000000000999', contract_status: s.contractor && s.owner ? 'fully_signed' : s.contractor ? 'signed_by_contractor' : 'awaiting_signatures',
    contractor_signed_at: s.contractor, owner_signed_at: s.owner, fully_signed_at: s.contractor && s.owner ? s.owner : null, rejected_reason: null,
    has_signed_pdf: false, sign_url: null, sandbox: true, last_error: null };
}

const CORE: Record<string, Handler> = {
  my_context: () => ({
    user_id: store.userId, email: store.user.email, email_verified: true, platform_admin: false,
    tenants: [{ tenant_id: TENANT, slug: 'demonstracao', name: 'Jardins Prime', tenant_status: 'active', role: store.user.role, permissions: store.user.permissions, commercial_state: 'full' }],
  }),
  platform_context: () => ({ role: null }),
  subscription_overview: (a) => { tenant(a); return { commercial_state: 'full', status: 'active', cycle: 'monthly', plan: { code: 'demo', name: 'Demonstração' },
    entitlements: { feature_ocr: true, feature_whatsapp: false, feature_totem: true, feature_reports_plus: true, max_units: 50 } }; },
  access_requests_pending_count: (a) => { tenant(a); return store.s.requests.filter((r) => r.status === 'pending').length; },
  staff_login_accounts_list: () => [],
  // Contrato fictício: assinatura bilateral simulada em memória (nunca chama a Autentique).
  contract_signature_status: (a) => { tenant(a); return [demoSignature()]; },
  contract_overview: (a) => { tenant(a); return { state: DEMO_SIG.contractor ? 'active' : 'none', current_version: '1.0', needs_new_acceptance: false, can_manage: false,
    acceptances: [{ id: '00000000-0000-4000-8000-000000000999', kind: 'original', status: DEMO_SIG.contractor ? 'active' : 'pending_verification', document_version: '1.0',
      terms: { plan_name: 'Profissional', cycle: 'monthly', amount_cents: 16900 }, representative_name: 'Carla Mendes', representative_email: 'si•••@exemplo.invalid',
      accepted_at: new Date(Date.now() - 3600_000).toISOString(), email_verified_at: DEMO_SIG.contractor, copy_status: null }] }; },
  access_incomplete_signups: () => [],

  my_notifications: (a) => {
    tenant(a);
    const all = store.s.notifications.filter((n) => n.user_id === store.userId).sort((x, y) => y.created_at.localeCompare(x.created_at));
    const items = all.filter((n) => (!a.p_unread || !n.read_at) && (!a.p_before || n.created_at < a.p_before)).slice(0, a.p_limit || 20)
      .map((n) => ({ ...n, package_status: n.package_id ? store.pkg(n.package_id)?.status ?? null : null }));
    return { unread: all.filter((n) => !n.read_at).length, items };
  },

  storage_availability: (a) => {
    tenant(a); staff();
    return STORAGE.filter((s) => s.active).sort((x, y) => x.sort_order - y.sort_order).map((s) => {
      const used = store.s.packages.filter((p) => WAITING.includes(p.status) && p.storage_location_id === s.id).length;
      return { ...s, used, free: Math.max(0, s.capacity - used), concierge: CONCIERGE[0].name };
    });
  },
  list_packages: (a) => {
    tenant(a); staff();
    const st = a.p_status === 'PENDENTES' ? PENDING : a.p_status ? [a.p_status] : null;
    const q = (a.p_search || '').toLowerCase();
    return store.s.packages.filter((p) => (!st || st.includes(p.status)) && (!a.p_from || p.received_at >= dayStart(a.p_from)) && (!a.p_to || p.received_at <= dayEnd(a.p_to))
      && (!q || `${unitText(p.unit_id)} ${p.tracking_code || ''} ${p.recipient_name || ''} ${p.carrier}`.toLowerCase().includes(q)))
      .sort(byRecent).filter(cursor(a)).slice(0, a.p_limit || 50).map(pkgRow);
  },
  receive_and_store: (a) => {
    tenant(a); staff();
    const dup = store.s.packages.find((p) => a.p_idempotency_key && p.idempotency_key === a.p_idempotency_key);
    if (dup) return { id: dup.id, storage_code: loc(dup.storage_location_id)?.code ?? null };
    if (!store.unit(a.p_unit)?.active) fail('Unidade inválida.');
    if (!String(a.p_courier || '').trim()) fail('Informe o nome do entregador.');
    if (!String(a.p_received_by_name || '').trim()) fail('Informe quem recebeu.');
    const p = newPackage(a, 'ARMAZENADA');
    if (!p.storage_location_id) p.storage_location_id = freeSlot()?.id ?? null;
    store.s.packages.push(p);
    store.notify(p.unit_id, 'package_received', 'Encomenda na portaria', `${p.carrier} aguardando retirada.`, p.id);
    store.changed('packages'); store.changed('notifications');
    return { id: p.id, storage_code: loc(p.storage_location_id)?.code ?? null };
  },
  confirm_preregistered: (a) => {
    tenant(a); staff();
    const p = store.pkg(a.p_package);
    if (!p || p.status !== 'PRE_REGISTRADA') fail('Pré-cadastro não encontrado.');
    Object.assign(p!, { status: 'ARMAZENADA', unit_id: a.p_unit || p!.unit_id, tracking_code: a.p_tracking || p!.tracking_code, carrier: a.p_carrier || p!.carrier,
      storage_location_id: a.p_storage_location || freeSlot()?.id || null, courier_name: a.p_courier, received_by_name: a.p_received_by_name, stored_at: nowIso(), notified_at: nowIso() });
    store.notify(p!.unit_id, 'package_received', 'Encomenda na portaria', `${p!.carrier} aguardando retirada.`, p!.id);
    store.changed('packages');
    return { id: p!.id, storage_code: loc(p!.storage_location_id)?.code ?? null };
  },
  attach_label_photo: (a) => {
    tenant(a); staff();
    if (!store.pkg(a.p_package) || !store.files.has(a.p_path)) fail('Foto não encontrada.');
    if (!store.s.attachments.some((x) => x.object_path === a.p_path)) {
      store.s.attachments.push({ package_id: a.p_package, kind: 'label_photo', object_path: a.p_path, position: store.s.attachments.filter((x) => x.package_id === a.p_package).length + 1, created_at: nowIso() });
      store.save();
    }
    return null;
  },
  move_package: (a) => {
    tenant(a); staff();
    const p = store.pkg(a.p_package), l = loc(a.p_storage_location);
    if (!p || !WAITING.includes(p.status) || !l) fail('Não foi possível mover.');
    p!.storage_location_id = l!.id; store.changed('packages'); return null;
  },
  resolve_package: (a) => {
    tenant(a); staff();
    const p = store.pkg(a.p_package);
    if (!p || !PENDING.includes(p.status)) fail('Encomenda não está pendente.');
    if (String(a.p_reason || '').trim().length < 5) fail('Informe o motivo.');
    Object.assign(p!, { status: a.p_status, resolution_reason: a.p_reason, resolved_at: nowIso() });
    store.changed('packages'); return null;
  },
  issue_pickup_token: (a) => {
    tenant(a);
    const p = mine(a.p_package);
    if (!WAITING.includes(p.status)) fail('Esta encomenda não está disponível para retirada.');
    if (p.rejected_at) fail('Encomenda recusada pelo morador: não está disponível para retirada.');
    const t = { token: `PPDEMO.${crypto.randomUUID()}`, package_id: p.id, expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(), used_at: null };
    store.s.tokens.push(t); store.save();
    return { token: t.token, expires_at: t.expires_at };
  },
  lookup_pickup_token: (a) => {
    tenant(a); staff();
    const t = store.s.tokens.find((x) => x.token === a.p_qr);
    if (!t || t.used_at || t.expires_at < nowIso()) fail('QR inválido, vencido ou já usado.');
    const p = store.pkg(t!.package_id);
    if (!p || !WAITING.includes(p.status)) fail('Esta encomenda não está mais aguardando retirada.');
    if (p!.rejected_at) fail('Encomenda recusada pelo morador: devolva pela portaria.');
    const l = loc(p!.storage_location_id);
    return { ...pkgRow(p!), storage_rack: l?.rack ?? null, storage_shelf: l?.shelf ?? null, concierge_name: CONCIERGE[0].name,
      label_photo_path: store.s.attachments.find((x) => x.package_id === p!.id)?.object_path ?? null };
  },
  deliver_package: (a) => {
    tenant(a); staff();
    const again = store.s.packages.find((p) => p.request_id && p.request_id === a.p_request);
    if (again) return { protocol: store.s.receipts.find((r) => r.package_id === again.id)?.protocol };
    const p = store.pkg(a.p_package);
    if (!p || !WAITING.includes(p.status)) fail('Esta encomenda não está mais aguardando retirada.');
    let tok;
    if (a.p_qr) {
      tok = store.s.tokens.find((x) => x.token === a.p_qr && x.package_id === p!.id);
      if (!tok || tok.used_at || tok.expires_at < nowIso()) fail('QR inválido, vencido ou já usado.');
    } else if (String(a.p_manual_reason || '').trim().length < 10) fail('Explique a retirada sem QR.');
    if (!store.files.has(a.p_signature_path) || !store.files.has(a.p_item_photo_path)) fail('Assinatura e foto são obrigatórias.');
    Object.assign(p!, { status: 'RETIRADA', picked_up_at: nowIso(), picked_up_by_name: a.p_picked_up_by, pickup_method: a.p_qr ? 'qr' : 'manual', delivered_by: store.userId, request_id: a.p_request });
    if (tok) tok.used_at = nowIso();
    const r = receiptFor(p!, store.s.units, a.p_qr ? null : a.p_manual_reason, a.p_recipient_kind, a.p_signature_path, a.p_item_photo_path);
    r.protocol = `DEMO-${new Date().getFullYear()}-${String(store.s.protoSeq++).padStart(5, '0')}`;
    r.snapshot.operator = store.user.full_name;
    store.s.receipts.push(r);
    store.notify(p!.unit_id, 'package_picked_up', 'Encomenda retirada', `Retirada por ${a.p_picked_up_by}.`, p!.id);
    store.changed('packages'); store.changed('notifications');
    return { protocol: r.protocol };
  },

  resident_home: (a) => {
    tenant(a);
    const units = a.p_unit ? [a.p_unit].filter((u) => myUnits().includes(u)) : myUnits();
    const all = store.s.packages.filter((p) => units.includes(p.unit_id!)).sort(byRecent);
    return { waiting: all.filter((p) => WAITING.includes(p.status)).map(residentPkg), recent: all.filter((p) => !WAITING.includes(p.status)).slice(0, 5).map(residentPkg),
      unread: store.s.notifications.filter((n) => n.user_id === store.userId && !n.read_at).length,
      channels: { push_devices: 0, whatsapp: false, email: true, push_enabled: false } };
  },
  resident_package: (a) => { tenant(a); return residentPkg(mine(a.p_package)); },
  resident_history: (a) => {
    tenant(a);
    const units = a.p_unit ? [a.p_unit].filter((u) => myUnits().includes(u)) : myUnits();
    const q = (a.p_search || '').toLowerCase();
    return store.s.packages.filter((p) => units.includes(p.unit_id!) && !WAITING.includes(p.status) && (!a.p_status || p.status === a.p_status)
      && (!a.p_from || p.received_at >= dayStart(a.p_from)) && (!a.p_to || p.received_at <= dayEnd(a.p_to))
      && (!q || `${p.carrier} ${p.tracking_code || ''} ${p.recipient_name || ''}`.toLowerCase().includes(q)))
      .sort(byRecent).filter(cursor(a)).slice(0, a.p_limit || 20).map(residentPkg);
  },
  resident_profile: (a) => {
    tenant(a);
    const ms = store.s.memberships.filter((m) => m.user_id === store.userId && m.role === 'morador' && m.status === 'active');
    return {
      full_name: store.user.full_name, email: store.user.email,
      units: ms.map((m) => { const u = store.unit(m.unit_id)!; return { id: u.id, block: u.block, label: u.label, since: m.since }; }),
      contacts: store.s.contacts.filter((c) => c.active && ms.some((m) => m.unit_id === c.unit_id)).map((c) => ({
        id: c.id, unit_id: c.unit_id, mine: c.user_id === store.userId, editable: true, name: c.name, phone: c.phone, email: c.email,
        notify_whatsapp: c.notify_whatsapp, notify_email: c.notify_email, has_whatsapp: !!c.phone, has_email: !!c.email })),
      whatsapp_available: false, email_available: true, portaria_contact: null,
    };
  },
};

export const HANDLERS: Record<string, Handler> = { ...CORE, ...ADMIN_HANDLERS, ...DASH_HANDLERS, ...PORTARIA_HANDLERS, ...COURIER_HANDLERS, ...IMPORT_HANDLERS, ...ASSISTANT_HANDLERS };
