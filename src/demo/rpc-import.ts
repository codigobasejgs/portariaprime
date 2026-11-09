import { nowIso, store } from './store';
import { admin, fail, tenant, unitText, type Handler } from './rpc';

/** Pré-cadastro por planilha e convites, em memória (mesmas RPCs/regras do banco; nada é enviado). */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const imports = () => (store.s.imports ||= []);
const registered = (unit: string) => store.s.memberships.some((m) => m.unit_id === unit)
  || store.s.requests.some((r) => r.status === 'pending' && r.unit_id === unit)
  || store.s.invitations.some((i) => i.unit_id === unit && !i.accepted_at && !i.revoked_at && i.expires_at > nowIso());

const KIND_EXCLUDED = /^(AUTORIZAD|PRESTADOR|FUNCIONARI|VISITANTE|EMPREGAD|DIARISTA|TERCEIRIZAD)/i;
const isExcludedKind = (k?: string | null) => KIND_EXCLUDED.test(norm(k || ''));

function plan(channel: string) {
  const byUnit = new Map<string, typeof store.s.imports>();
  for (const e of imports()) byUnit.set(e.unit_id, [...(byUnit.get(e.unit_id) || []), e]);
  const seenRcpt = new Set<string>();
  return [...byUnit].map(([unit, es]) => {
    const rcpt = (e: (typeof es)[number]) => (channel === 'email' ? e.email : e.phone);
    // Morador > já convidado > com contato no canal > mais antigo.
    const e = [...es].sort((a, b) => Number(b.status === 'completed') - Number(a.status === 'completed')
      || Number(isExcludedKind(a.kind)) - Number(isExcludedKind(b.kind))
      || Number(!!b.invited_at) - Number(!!a.invited_at)
      || Number(!rcpt(a)) - Number(!rcpt(b)))[0];
    const r = rcpt(e);
    let reason = !store.unit(unit)?.active ? 'unidade_inativa' : registered(unit) ? 'unidade_cadastrada' : e.status === 'completed' ? 'convite_usado'
      : isExcludedKind(e.kind) ? 'tipo_nao_morador' : e.invited_at ? 'ja_convidado' : !r ? 'sem_contato' : null;
    if (!reason && r) {
      if (seenRcpt.has(r)) reason = 'destinatario_repetido';
      else seenRcpt.add(r);
    }
    return { e, unit: unitText(unit), reason };
  });
}

export const IMPORT_HANDLERS: Record<string, Handler> = {
  resident_import_save: (a) => {
    tenant(a); admin();
    const rows: any[] = Array.isArray(a.p_rows) ? a.p_rows : [];
    if (!rows.length) fail('Nenhuma pessoa para importar.');
    let inserted = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const name = String(r.full_name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (name.length < 2 || !store.unit(r.unit_id)?.active) { skipped++; continue; }
      const phone = /^\+55\d{11}$/.test(r.phone || '') ? r.phone : null;
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.email || '') ? String(r.email).toLowerCase() : null;
      const old = imports().find((e) => e.unit_id === r.unit_id && norm(e.full_name) === norm(name));
      if (old?.status === 'completed') { skipped++; continue; }
      if (old) { Object.assign(old, { phone: phone || old.phone, email: email || old.email, kind: r.kind || old.kind, extra: r.extra || {}, status: old.status === 'no_contact' ? 'pending' : old.status }); updated++; }
      else { imports().push({ id: crypto.randomUUID(), unit_id: r.unit_id, full_name: name, kind: r.kind || null, phone, email, extra: r.extra || {}, status: 'pending', channel: null, invited_at: null }); inserted++; }
    }
    store.save();
    return { batch_id: crypto.randomUUID(), inserted, updated, skipped };
  },
  resident_import_list: (a) => {
    tenant(a); admin();
    const counts: Record<string, number> = {};
    for (const e of imports()) counts[e.status] = (counts[e.status] || 0) + 1;
    return { entries: imports().map((e) => ({ ...e, unit: unitText(e.unit_id), last_error: null, registered: registered(e.unit_id) }))
      .sort((x, y) => String(x.unit).localeCompare(String(y.unit)) || x.full_name.localeCompare(y.full_name)), counts };
  },
  resident_import_delete: (a) => {
    tenant(a); admin();
    const before = imports().length;
    store.s.imports = a.p_entries ? imports().filter((e) => !a.p_entries.includes(e.id)) : [];
    store.save();
    return before - store.s.imports.length;
  },
  resident_invite_preview: (a) => {
    tenant(a); admin();
    const channel = a.p_channel || 'whatsapp', limit = Math.min(Math.max(a.p_limit || 100, 1), 300);
    const p = plan(channel), eligible = p.filter((x) => !x.reason).length;
    const excluded: Record<string, number> = {};
    for (const x of p) if (x.reason) excluded[x.reason] = (excluded[x.reason] || 0) + 1;
    return { channel, limit, units: p.length, eligible, will_send: Math.min(eligible, limit), remaining: Math.max(eligible - limit, 0), excluded,
      left_out: p.filter((x) => x.reason).map((x) => ({ unit: x.unit, full_name: x.e.full_name, reason: x.reason })) };
  },
  // Demonstração: marca como enviado na hora (sem fila, sem mensagem real).
  resident_invite_send: (a) => {
    tenant(a); admin();
    const channel = a.p_channel || 'whatsapp', limit = Math.min(Math.max(a.p_limit || 100, 1), 300);
    const p = plan(channel);
    let no_contact = 0;
    for (const x of p) if (x.reason === 'sem_contato') for (const e of imports().filter((y) => y.unit_id === x.e.unit_id && y.status === 'pending' && !(channel === 'email' ? y.email : y.phone))) { e.status = 'no_contact'; no_contact++; }
    const ok = p.filter((x) => !x.reason);
    for (const x of ok.slice(0, limit)) Object.assign(x.e, { status: channel === 'email' ? 'sent_email' : 'sent_whatsapp', channel, invited_at: nowIso() });
    store.save();
    const queued = Math.min(ok.length, limit);
    return { queued, no_contact, remaining: Math.max(ok.length - limit, 0), minutes: Math.ceil(Math.max(queued - 1, 0) * 20 / 60) };
  },
  // ponytail: a demo não emite link de convite (não há token nem portal público); peek/complete respondem "inválido".
  resident_invite_peek: () => null,
  resident_invite_complete: () => ({ status: 'invalid', request_id: null }),
};
