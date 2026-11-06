import { TENANT, profile } from './mode';

/** Fictitious, deterministic seed for /demonstracao. Lives in memory; mirrored to sessionStorage when allowed. */
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const nowIso = () => new Date().toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const KEY = 'pp-demo-store';

export interface User { id: string; email: string; full_name: string; role: 'admin' | 'porteiro' | 'morador'; permissions: string[]; contact_phone: string | null; contact_email: string | null }
export interface Membership { id: string; user_id: string; role: User['role']; status: 'active' | 'pending' | 'revoked'; unit_id: string | null; relation: string | null; since: string }
export interface Unit { id: string; tenant_id: string; block: string | null; label: string; active: boolean }
export interface Pkg {
  id: string; ref: string; status: string; carrier: string; tracking_code: string | null; recipient_name: string | null; notes: string | null;
  unit_id: string | null; received_at: string; stored_at: string | null; notified_at: string | null; picked_up_at: string | null; picked_up_by_name: string | null;
  pickup_method: string | null; delivered_by: string | null; resolution_reason: string | null; resolved_at: string | null;
  storage_location_id: string | null; courier_name: string | null; received_by_name: string | null; registered_via: string; idempotency_key?: string; request_id?: string;
}
export interface Receipt { tenant_id: string; package_id: string; protocol: string; issued_at: string; pdf_status: 'ready'; verify_code: null; snapshot: Record<string, any> }
export interface AccessRequest {
  id: string; full_name: string; email: string; phone: string; email_verified: boolean; unit_id: string | null; block_text: string | null; unit_text: string;
  relation: string; created_at: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; privacy_version: string; privacy_accepted_at: string; decided_at: string | null; reason: string | null;
}
export interface Invitation { id: string; email: string; role: 'morador'; unit_id: string; expires_at: string; created_at: string; accepted_at: null; revoked_at: string | null }
export interface Notice { id: string; user_id: string; kind: string; title: string; body: string; package_id: string | null; read_at: string | null; created_at: string }
export interface Contact { id: string; user_id: string; unit_id: string; name: string; phone: string | null; email: string | null; notify_whatsapp: boolean; notify_email: boolean; active: boolean }
export interface Token { token: string; package_id: string; expires_at: string; used_at: string | null }
export interface Attachment { package_id: string; kind: 'label_photo'; object_path: string; position: number; created_at: string }

const ADMIN = uid(10), PORTEIRO = uid(11), MORADOR = uid(20);
const STAFF = 'José Santos';

function seed() {
  const units: Unit[] = [['A', '101'], ['A', '102'], ['A', '201'], ['A', '202'], ['B', '101'], ['B', '102'], ['B', '201'], ['B', '202']]
    .map(([block, label], i) => ({ id: uid(i + 1), tenant_id: TENANT, block, label, active: true }));
  // 12 residents in the 8 units; resident profile = João Silva (A-101).
  const people: [string, number, string][] = [
    ['João Silva', 1, 'proprietario'], ['Ana Silva', 1, 'conjuge'], ['Marina Costa', 2, 'locatario'], ['Rafael Lima', 3, 'proprietario'],
    ['Beatriz Rocha', 3, 'filho'], ['Paulo Nogueira', 4, 'proprietario'], ['Luciana Prado', 5, 'locatario'], ['Eduardo Ramos', 6, 'proprietario'],
    ['Camila Duarte', 6, 'conjuge'], ['Fernando Alves', 7, 'proprietario'], ['Patrícia Moura', 8, 'locatario'], ['Ricardo Teles', 8, 'proprietario'],
  ];
  const slug = (n: string) => n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '.');
  const users: User[] = [
    { id: ADMIN, email: 'sindica@exemplo.invalid', full_name: 'Carla Mendes', role: 'admin', permissions: ['team', 'approve', 'settings'], contact_phone: '+5511900000010', contact_email: 'sindica@exemplo.invalid' },
    { id: PORTEIRO, email: 'portaria@exemplo.invalid', full_name: STAFF, role: 'porteiro', permissions: [], contact_phone: null, contact_email: null },
    ...people.map(([name], i) => ({ id: uid(20 + i), email: `${slug(name)}@exemplo.invalid`, full_name: name, role: 'morador' as const, permissions: [],
      contact_phone: `+55119000000${String(20 + i).padStart(2, '0')}`, contact_email: `${slug(name)}@exemplo.invalid` })),
  ];
  const memberships: Membership[] = [
    { id: uid(510), user_id: ADMIN, role: 'admin', status: 'active', unit_id: null, relation: null, since: ago(24 * 400) },
    { id: uid(511), user_id: PORTEIRO, role: 'porteiro', status: 'active', unit_id: null, relation: null, since: ago(24 * 300) },
    ...people.map(([, u, relation], i) => ({ id: uid(520 + i), user_id: uid(20 + i), role: 'morador' as const, status: 'active' as const, unit_id: uid(u), relation, since: ago(24 * (200 - i * 10)) })),
  ];
  const contacts: Contact[] = users.filter((u) => u.role === 'morador').map((u, i) => ({
    id: uid(400 + i), user_id: u.id, unit_id: memberships.find((m) => m.user_id === u.id)!.unit_id!, name: u.full_name,
    phone: u.contact_phone, email: u.contact_email, notify_whatsapp: false, notify_email: true, active: true,
  }));
  const carriers = ['Correios', 'Mercado Livre', 'Amazon', 'Shopee', 'Correios', 'Magalu'];
  const couriers = ['Marcos (Correios)', 'Lia - Mercado Livre', 'Diego - Amazon', 'Tati - Shopee', 'Marcos (Correios)', 'Bruno - Magalu'];
  const loc = [uid(91), uid(91), uid(92), uid(92), uid(93), uid(91)];
  const waitingUnits = [1, 1, 3, 5, 6, 8];
  const waitingHours = [3, 30, 9, 50, 80, 20];
  const recip = (u: number) => people.find(([, x]) => x === u)?.[0] || null;
  const pkgs: Pkg[] = waitingUnits.map((u, i) => ({
    id: uid(101 + i), ref: `JP-${1001 + i}`, status: 'ARMAZENADA', carrier: carriers[i], tracking_code: `DM${String(482910 + i * 37)}BR`, recipient_name: recip(u), notes: null,
    unit_id: uid(u), received_at: ago(waitingHours[i]), stored_at: ago(waitingHours[i] - 0.1), notified_at: ago(waitingHours[i] - 0.1), picked_up_at: null, picked_up_by_name: null,
    pickup_method: null, delivered_by: null, resolution_reason: null, resolved_at: null, storage_location_id: loc[i], courier_name: couriers[i], received_by_name: STAFF, registered_via: 'portaria',
  }));
  const receipts: Receipt[] = [];
  for (let i = 0; i < 10; i++) {
    const u = (i % 8) + 1, rec = 24 * (2 + i * 2.7) + (i % 4) * 3, wait = 4 + (i * 7) % 40;
    const p: Pkg = {
      id: uid(111 + i), ref: `JP-${990 - i}`, status: 'RETIRADA', carrier: carriers[i % 6], tracking_code: `DM${String(471200 + i * 53)}BR`, recipient_name: recip(u), notes: null,
      unit_id: uid(u), received_at: ago(rec), stored_at: ago(rec - 0.1), notified_at: ago(rec - 0.1), picked_up_at: ago(rec - wait), picked_up_by_name: recip(u),
      pickup_method: i % 4 === 3 ? 'manual' : 'qr', delivered_by: PORTEIRO, resolution_reason: null, resolved_at: null, storage_location_id: loc[i % 6], courier_name: couriers[i % 6],
      received_by_name: STAFF, registered_via: 'portaria',
    };
    pkgs.push(p);
    receipts.push(receiptFor(p, units, p.pickup_method === 'manual' ? 'Morador sem celular, documento conferido' : null, 'morador', null, null));
  }
  const requests: AccessRequest[] = [
    { id: uid(201), full_name: 'Gustavo Pereira', email: 'gustavo.pereira@exemplo.invalid', phone: '+5511900000201', email_verified: true, unit_id: uid(2), block_text: 'A', unit_text: '102',
      relation: 'locatario', created_at: ago(20), status: 'pending', privacy_version: '1.0', privacy_accepted_at: ago(20), decided_at: null, reason: null },
    { id: uid(202), full_name: 'Helena Castro', email: 'helena.castro@exemplo.invalid', phone: '+5511900000202', email_verified: true, unit_id: uid(7), block_text: 'B', unit_text: '201',
      relation: 'proprietario', created_at: ago(5), status: 'pending', privacy_version: '1.0', privacy_accepted_at: ago(5), decided_at: null, reason: null },
  ];
  const invitations: Invitation[] = [{ id: uid(250), email: 'novo.morador@exemplo.invalid', role: 'morador', unit_id: uid(4), expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(), created_at: ago(48), accepted_at: null, revoked_at: null }];
  const notifications: Notice[] = [];
  for (const p of pkgs) for (const m of memberships.filter((x) => x.role === 'morador' && x.unit_id === p.unit_id)) {
    notifications.push({ id: crypto.randomUUID(), user_id: m.user_id, kind: 'package_received', title: 'Encomenda na portaria', body: `${p.carrier} aguardando retirada.`, package_id: p.id, read_at: p.picked_up_at ? p.picked_up_at : null, created_at: p.notified_at! });
    if (p.picked_up_at) notifications.push({ id: crypto.randomUUID(), user_id: m.user_id, kind: 'package_picked_up', title: 'Encomenda retirada', body: `Retirada por ${p.picked_up_by_name}.`, package_id: p.id, read_at: p.picked_up_at, created_at: p.picked_up_at });
  }
  const settings = {
    tenant_id: TENANT, condo_type: 'vertical', unit_group_label: 'Bloco', unit_number_label: 'Apartamento',
    notify_email: true, notify_whatsapp: false, notify_push: true, qr_ttl_hours: 48, max_residents_per_unit: 6,
    reminder_enabled: true, reminder_after_hours: 24, reminder_interval_hours: 24, reminder_max: 3, reminder_start_hour: 8, reminder_end_hour: 20,
  };
  return { units, users, memberships, contacts, packages: pkgs, receipts, requests, invitations, notifications, settings,
    tokens: [] as Token[], attachments: [] as Attachment[], seq: 1100, protoSeq: 1 };
}

/** Immutable snapshot, same fields the real receipt row carries. */
export function receiptFor(p: Pkg, units: Unit[], manualReason: string | null, kind: string, sig: string | null, photo: string | null): Receipt {
  const u = units.find((x) => x.id === p.unit_id);
  const loc = STORAGE.find((s) => s.id === p.storage_location_id);
  return {
    tenant_id: TENANT, package_id: p.id, protocol: `DEMO-${p.ref}`, issued_at: p.picked_up_at!, pdf_status: 'ready', verify_code: null,
    snapshot: {
      tracking_code: p.tracking_code, carrier: p.carrier, unit_block: u?.block ?? null, unit_label: u?.label ?? null, unit_text: u ? `${u.block ? `${u.block}-` : ''}${u.label}` : null,
      received_at: p.received_at, picked_up_at: p.picked_up_at, picked_up_by: p.picked_up_by_name, operator: STAFF, method: manualReason ? 'manual' : 'qr',
      manual_reason: manualReason, recipient_kind: kind, storage: loc ? `Portaria principal › Estante ${loc.rack} › Prateleira ${loc.shelf}` : null,
      received_by_name: p.received_by_name, courier_name: p.courier_name, signature_path: sig, handover_path: photo,
    },
  };
}

export const CONCIERGE = [{ id: uid(90), tenant_id: TENANT, name: 'Portaria principal', active: true, created_at: '2026-01-01T12:00:00Z' }];
export const STORAGE = [
  { id: uid(91), tenant_id: TENANT, code: 'A1', rack: 'A', shelf: '1', notes: null, capacity: 12, active: true, sort_order: 1, is_contingency: false, concierge_location_id: uid(90) },
  { id: uid(92), tenant_id: TENANT, code: 'A2', rack: 'A', shelf: '2', notes: null, capacity: 12, active: true, sort_order: 2, is_contingency: false, concierge_location_id: uid(90) },
  { id: uid(93), tenant_id: TENANT, code: 'B1', rack: 'B', shelf: '1', notes: null, capacity: 8, active: true, sort_order: 3, is_contingency: true, concierge_location_id: uid(90) },
];

type State = ReturnType<typeof seed>;

function load(): State {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return { ...seed(), ...JSON.parse(raw) };
  } catch { /* blocked or corrupt: fresh seed */ }
  return seed();
}

export const store = {
  s: load(),
  /** Uploaded blobs (signature, photos). Memory only: never persisted, never sent anywhere. */
  files: new Map<string, Blob>(),
  get userId() { const p = profile(); return p === 'admin' ? ADMIN : p === 'morador' ? MORADOR : PORTEIRO; },
  get user() { return this.s.users.find((u) => u.id === this.userId)!; },
  save() { try { sessionStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* memory only */ } },
  changed(table: string) { this.save(); window.dispatchEvent(new CustomEvent('pp-demo-change', { detail: table })); },
  reset() { try { sessionStorage.removeItem(KEY); } catch { /* memory only */ } this.s = seed(); this.files.clear(); location.reload(); },
  unit(id: string | null) { return this.s.units.find((u) => u.id === id); },
  pkg(id: string) { return this.s.packages.find((p) => p.id === id); },
  /** Active resident memberships of one unit. */
  residents(unitId: string | null) { return this.s.memberships.filter((m) => m.role === 'morador' && m.status === 'active' && m.unit_id === unitId); },
  notify(unitId: string | null, kind: string, title: string, body: string, packageId: string) {
    for (const m of this.residents(unitId)) this.s.notifications.unshift({ id: crypto.randomUUID(), user_id: m.user_id, kind, title, body, package_id: packageId, read_at: null, created_at: nowIso() });
  },
};
export const IDS = { ADMIN, PORTEIRO, MORADOR };
