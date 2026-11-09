import { nowIso, store, type DemoCourier } from './store';
import { admin, fail, staff, tenant, type Handler } from './rpc';

/** Entregadores (CNH) na demonstração: mesmas regras de privacidade das RPCs reais, dados só em memória. */
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const cpfOk = (d: string) => {
  if (d.length !== 11 || /^(\d)\1*$/.test(d)) return false;
  return [9, 10].every((k) => { let s = 0; for (let i = 0; i < k; i++) s += +d[i] * (k + 1 - i); return ((s * 10) % 11) % 10 === +d[k]; });
};
const fmt = (d: string) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
const hint = (c: DemoCourier) => (c.document_number ? `${c.document_number.slice(0, 3)}.***.***-**` : null);
const masked = (c: DemoCourier) => (c.document_number ? `***.${c.document_number.slice(3, 6)}.${c.document_number.slice(6, 9)}-**` : null);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const list = () => (store.s.couriers ||= []);
const find = (id: string) => list().find((c) => c.id === id) || fail('Entregador não encontrado.');
const out = (c: DemoCourier) => ({ id: c.id, full_name: c.full_name, carrier_default: c.carrier_default, cnh_category: c.cnh_category, document_hint: hint(c) });

export const COURIER_HANDLERS: Record<string, Handler> = {
  courier_upsert_from_ocr: (a) => {
    tenant(a); staff();
    const name = String(a.p_full_name || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 80) fail('Informe o nome do entregador (2 a 80 caracteres).');
    const cpf = digits(a.p_cpf) || null, cnh = digits(a.p_cnh) || null;
    if (!cpf && !cnh) fail('Informe o CPF ou o número da CNH.');
    if (cpf && !cpfOk(cpf)) fail('CPF inválido: confira os dígitos.');
    if (cnh && (cnh.length !== 11 || /^(\d)\1*$/.test(cnh))) fail('Número da CNH inválido (11 dígitos).');
    const byCpf = cpf ? list().find((c) => c.document_number === cpf) : undefined;
    const byCnh = cnh ? list().find((c) => c.cnh_number === cnh) : undefined;
    if (byCpf && byCnh && byCpf.id !== byCnh.id) fail('CPF e CNH pertencem a entregadores diferentes. Confira o documento.');
    const hit = byCpf || byCnh;
    if (hit && cpf && hit.document_number && hit.document_number !== cpf) fail('O CPF lido não confere com o cadastro desta CNH. Confira o documento.');
    const c: DemoCourier = hit || { id: crypto.randomUUID(), full_name: name, document_number: null, cnh_number: null, cnh_category: null, carrier_default: null,
      has_photo: false, created_at: nowIso(), last_visit_at: null };
    Object.assign(c, { full_name: name, document_number: cpf || c.document_number, cnh_number: cnh || c.cnh_number,
      cnh_category: a.p_category || c.cnh_category, carrier_default: a.p_carrier || c.carrier_default });
    if (!hit) list().push(c);
    store.changed('couriers');
    return { ...out(c), created: !hit };
  },
  courier_search: (a) => {
    tenant(a); staff();
    const q = String(a.p_query || ''), d = digits(q);
    const words = norm(q).split(' ').filter(Boolean);
    return list().filter((c) => (d.length >= 3 ? !!c.document_number?.startsWith(d.slice(0, 3)) : words.every((w) => norm(c.full_name).includes(w))))
      .slice(0, 8).map(out);
  },
  courier_reveal_document: (a) => {
    tenant(a); admin();
    if (!store.user.permissions.some((p) => p === 'approve' || p === 'team')) fail('Somente quem aprova moradores ou gerencia a equipe vê o documento completo.');
    const reason = String(a.p_reason || '').trim();
    if (reason.length < 10 || reason.length > 1000) fail('Justificativa obrigatória (10 a 1000 caracteres).');
    const c = find(a.p_courier);
    return { id: c.id, full_name: c.full_name, cnh_category: c.cnh_category, document_number: c.document_number && fmt(c.document_number), cnh_number: c.cnh_number };
  },
  couriers_list: (a) => {
    tenant(a); admin();
    return list().map((c) => {
      const pk = store.s.packages.filter((p) => p.courier_id === c.id);
      const last = pk.map((p) => p.received_at).sort().pop() || null;
      return { id: c.id, full_name: c.full_name, document_masked: masked(c), has_cnh: !!c.cnh_number, cnh_category: c.cnh_category, has_photo: c.has_photo,
        created_at: c.created_at, last_visit_at: c.last_visit_at, carriers: [...new Set(pk.map((p) => p.carrier))].sort(), deliveries: pk.length, last_delivery: last };
    }).sort((x, y) => (y.last_delivery || '').localeCompare(x.last_delivery || '') || x.full_name.localeCompare(y.full_name));
  },
  courier_deliveries: (a) => {
    tenant(a); admin(); find(a.p_courier);
    if (!a.p_cursor_at !== !a.p_cursor_id) fail('Cursor inválido.');
    const key = (p: { received_at: string; id: string }) => `${p.received_at}|${p.id}`;
    const after = a.p_cursor_at ? `${a.p_cursor_at}|${a.p_cursor_id}` : null;
    return store.s.packages.filter((p) => p.courier_id === a.p_courier && (!after || key(p) < after)).sort((x, y) => key(y).localeCompare(key(x)))
      .slice(0, Math.min(Math.max(a.p_limit || 100, 1), 500))
      .map((p) => { const u = store.unit(p.unit_id); return { package_id: p.id, received_at: p.received_at, carrier: p.carrier, status: p.status,
        courier_name: p.courier_name, received_by_name: p.received_by_name, unit_block: u?.block ?? null, unit_label: u?.label ?? '' }; });
  },
  package_set_courier: (a) => {
    tenant(a); staff();
    const p = store.pkg(a.p_package) || fail('Encomenda não encontrada.');
    const c = find(a.p_courier);
    if (p!.courier_id === c.id) return { package_id: p!.id, courier_id: c.id, replayed: true };
    if (p!.courier_id) fail('Encomenda já vinculada a outro entregador.');
    if (!['RECEBIDA', 'ARMAZENADA'].includes(p!.status)) fail('Histórico encerrado: vínculo do entregador não pode ser alterado.');
    const names = [c.full_name, `${c.full_name} - ${c.carrier_default || ''}`.slice(0, 80)].map(norm);
    if (!names.includes(norm(p!.courier_name || ''))) fail('Nome do entregador não confere com o snapshot do recebimento.');
    p!.courier_id = c.id; c.last_visit_at = nowIso();
    store.changed('packages');
    return { package_id: p!.id, courier_id: c.id, replayed: false };
  },
  courier_photo_authorize: (a) => {
    tenant(a); staff();
    return { actor_id: store.user.id, has_photo: find(a.p_courier).has_photo };
  },
  // Na demonstração o "servidor" é o próprio navegador: o arquivo precisa existir antes do vínculo, sem troca.
  courier_attach_photo: (a) => {
    tenant(a); staff();
    const c = find(a.p_courier);
    if (!store.files.has(`couriers/${c.id}`)) fail('Arquivo não encontrado.');
    if (c.has_photo) fail('Foto já guardada; substituição não permitida.');
    c.has_photo = true; store.changed('couriers');
    return { id: c.id, replayed: false };
  },
  courier_photo_reveal: (a) => {
    tenant(a); admin();
    if (!store.user.permissions.some((p) => p === 'approve' || p === 'team')) fail('Sem permissão para esta ação.');
    const reason = String(a.p_reason || '').trim();
    if (reason.length < 10 || reason.length > 1000) fail('Justificativa obrigatória (10 a 1000 caracteres).');
    const c = find(a.p_courier);
    if (!c.has_photo || !store.files.has(`couriers/${c.id}`)) fail('Foto não encontrada.');
    return { path: `couriers/${c.id}` };
  },
};
