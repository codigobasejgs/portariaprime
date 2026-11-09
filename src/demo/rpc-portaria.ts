import { nowIso, store, type Keyword } from './store';
import { admin, fail, myUnits, pkgRow, staff, tenant, WAITING, type Handler } from './rpc';

/** Portaria: morador não identificado, recusa pelo morador e palavra-chave de entrega (mesmos nomes da migration 20261109000100). */
const userName = (id: string) => store.s.users.find((u) => u.id === id)?.full_name ?? null;
const waiting = (id: string) => {
  const p = store.pkg(id) || fail('Encomenda não encontrada.');
  if (!WAITING.includes(p.status)) fail('Esta encomenda não está aguardando retirada.');
  return p;
};
const unitPeople = (unitId: string | null, contacts: boolean) => [
  ...store.s.memberships.filter((m) => m.role === 'morador' && m.unit_id === unitId).map((m) => {
    const u = store.s.users.find((x) => x.id === m.user_id);
    return { name: u?.full_name ?? '', status: m.status, ...(contacts ? { phone: u?.contact_phone ?? null, email: u?.email ?? null } : {}) };
  }),
  ...store.s.requests.filter((r) => r.status === 'pending' && r.unit_id === unitId)
    .map((r) => ({ name: r.full_name, status: 'pending', ...(contacts ? { phone: r.phone, email: r.email } : {}) })),
];
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
function kwJson(k: Keyword) {
  const u = store.unit(k.unit_id);
  return { ...k, unit_block: u?.block ?? null, unit_label: u?.label ?? '', created_by_name: userName(k.created_by) };
}
const kwOf = (id: string) => store.s.keywords.find((k) => k.id === id) || fail('Palavra-chave não encontrada.');
/** Autor (morador da unidade) ou equipe; outro morador da mesma unidade nunca. */
const kwMine = (id: string) => {
  const k = kwOf(id);
  if (store.user.role === 'morador' && !(k.created_by === store.userId && myUnits().includes(k.unit_id))) fail('Palavra-chave não encontrada.');
  return k;
};
const kwExpired = (k: Keyword) => (k.expires_at != null && k.expires_at <= nowIso()) || (k.valid_until != null && k.valid_until < today());

export const PORTARIA_HANDLERS: Record<string, Handler> = {
  unit_residents_for_staff: (a) => { tenant(a); staff(); return unitPeople(a.p_unit, false); },
  package_mark_unidentified: (a) => {
    tenant(a); staff();
    if (a.p_reason != null && !['unregistered_resident', 'incomplete_or_unknown_name'].includes(a.p_reason)) fail('Motivo inválido.');
    const p = waiting(a.p_package);
    p.unidentified_reason = a.p_reason ?? null;
    store.changed('packages');
    return pkgRow(p);
  },
  list_unidentified_packages: (a) => {
    tenant(a); admin();
    return store.s.packages.filter((p) => p.unidentified_reason && WAITING.includes(p.status)).sort((x, y) => y.received_at.localeCompare(x.received_at))
      .map((p) => ({ ...pkgRow(p), label_photo_path: store.s.attachments.find((x) => x.package_id === p.id)?.object_path ?? null, residents: unitPeople(p.unit_id, true) }));
  },
  package_destinate: (a) => {
    tenant(a); admin();
    const p = waiting(a.p_package);
    if (!store.unit(a.p_unit)?.active) fail('Unidade inválida ou desativada.');
    let name = String(a.p_recipient ?? '').trim() || null;
    if (a.p_resident_user) {
      if (!store.residents(a.p_unit).some((m) => m.user_id === a.p_resident_user)) fail('Morador não está ativo nesta unidade.');
      name = userName(a.p_resident_user);
    }
    if (name && name.length > 120) fail('Nome do destinatário muito longo.');
    const moved = p.unit_id !== a.p_unit;
    Object.assign(p, { unit_id: a.p_unit, recipient_name: name, unidentified_reason: null });
    if (moved) {
      for (const t of store.s.tokens) if (t.package_id === p.id && !t.used_at) t.used_at = nowIso();
      store.notify(p.unit_id, 'package_received', 'Encomenda na portaria', `${p.carrier} aguardando retirada.`, p.id);
      store.changed('notifications');
    }
    store.changed('packages');
    return pkgRow(p);
  },
  resident_reject_package: (a) => {
    tenant(a);
    const p = store.pkg(a.p_package);
    if (!p || !myUnits().includes(p.unit_id!)) fail('Encomenda não encontrada.');
    if (p!.rejected_at) return pkgRow(p!);
    if (!WAITING.includes(p!.status)) fail('Esta encomenda não está aguardando retirada.');
    if (!['wrong_unit', 'cancelled', 'other'].includes(a.p_reason)) fail('Motivo inválido.');
    const note = String(a.p_note ?? '').trim() || null;
    if (a.p_reason === 'other' && (note?.length ?? 0) < 3) fail('Descreva o motivo da recusa.');
    if ((note?.length ?? 0) > 300) fail('Observação muito longa (máx. 300).');
    Object.assign(p!, { rejected_at: nowIso(), rejected_by: store.userId, rejection_reason: a.p_reason, rejection_note: note });
    for (const t of store.s.tokens) if (t.package_id === p!.id && !t.used_at) t.used_at = nowIso();
    const team = store.s.memberships.filter((m) => (m.role === 'admin' || m.role === 'porteiro') && m.status === 'active');
    for (const m of team) store.s.notifications.unshift({ id: crypto.randomUUID(), user_id: m.user_id, kind: 'package_rejected', title: 'Encomenda recusada pelo morador',
      body: `${p!.carrier} #${p!.ref}: devolver ao remetente.`, package_id: p!.id, read_at: null, created_at: nowIso() });
    store.changed('packages'); store.changed('notifications');
    return pkgRow(p!);
  },
  staff_package_flags: (a) => {
    tenant(a); staff();
    return store.s.packages.filter((p) => WAITING.includes(p.status) && (p.rejected_at || p.unidentified_reason))
      .map((p) => ({ id: p.id, rejected_at: p.rejected_at ?? null, rejection_reason: p.rejection_reason ?? null, rejection_note: p.rejection_note ?? null, unidentified_reason: p.unidentified_reason ?? null }));
  },

  delivery_keyword_save: (a) => {
    tenant(a);
    const kw = String(a.p_keyword ?? '').trim();
    let k: Keyword | undefined;
    if (a.p_id) {
      k = kwMine(a.p_id);
      if (k.status !== 'active') fail('Palavra-chave já utilizada ou cancelada.');
    } else if (!myUnits().includes(a.p_unit)) fail('Somente moradores da unidade podem informar palavra-chave.');
    if (kw.length < 2 || kw.length > 60) fail('Palavra-chave deve ter de 2 a 60 caracteres.');
    if (String(a.p_carrier ?? '').length > 40 || String(a.p_recipient ?? '').length > 120 || String(a.p_note ?? '').length > 300) fail('Texto muito longo.');
    if (a.p_valid_until && a.p_valid_until < today()) fail('A validade não pode estar no passado.');
    const fields = { keyword: kw, carrier: a.p_carrier || null, recipient_name: a.p_recipient || null, note: a.p_note || null, valid_until: a.p_valid_until || null };
    if (k) Object.assign(k, fields);
    else store.s.keywords.unshift(k = { id: crypto.randomUUID(), unit_id: a.p_unit, created_by: store.userId, status: 'active', used_at: null, created_at: nowIso(), expires_at: null, ...fields });
    store.changed('delivery_keywords');
    return kwJson(k);
  },
  delivery_keyword_save_v2: (a) => {
    const exp = a.p_expires_at ? new Date(a.p_expires_at) : null;
    if (exp && (Number.isNaN(exp.getTime()) || exp.toISOString() <= nowIso())) fail('A validade deve estar no futuro.');
    const r = PORTARIA_HANDLERS.delivery_keyword_save({ ...a, p_valid_until: null }) as { id: string };
    const k = kwOf(r.id);
    k.expires_at = exp ? exp.toISOString() : null;
    store.changed('delivery_keywords');
    return kwJson(k);
  },
  delivery_keyword_cancel: (a) => {
    tenant(a);
    const k = kwMine(a.p_id);
    if (k.status === 'used') fail('Palavra-chave já utilizada.');
    k.status = 'cancelled';
    store.changed('delivery_keywords');
    return kwJson(k);
  },
  delivery_keyword_mark_used: (a) => {
    tenant(a);
    const k = kwMine(a.p_id);
    if (k.status === 'used') return kwJson(k);
    if (kwExpired(k)) fail('Palavra-chave expirada.');
    if (k.status === 'cancelled') fail('Palavra-chave cancelada pelo morador.');
    Object.assign(k, { status: 'used', used_at: nowIso(), used_by: store.userId });
    store.changed('delivery_keywords');
    return kwJson(k);
  },
  list_delivery_keywords: (a) => {
    tenant(a);
    const isStaff = store.user.role !== 'morador', since = new Date(Date.now() - 90 * 86400_000).toISOString();
    return store.s.keywords.filter((k) => (!a.p_unit || k.unit_id === a.p_unit) && (k.status !== 'active' || !kwExpired(k))
      && (isStaff ? k.status === 'active' : k.created_by === store.userId && myUnits().includes(k.unit_id) && k.created_at > since)).map(kwJson);
  },
};
