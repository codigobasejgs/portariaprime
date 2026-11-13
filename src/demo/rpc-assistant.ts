import { nowIso, store } from './store';
import { admin, fail, tenant, type Handler } from './rpc';

/** Painel do assistente na /demonstracao: números autorizados em memória (mesmos nomes de RPC da migration 20261113000100). */
const LEVELS = ['basic', 'intermediate', 'advanced'];
let links = [{ id: crypto.randomUUID(), phone: '5511900000001', level: 'intermediate', label: 'Síndica', active: true, user_id: '', usable: true, created_at: nowIso() }];
const team = () => store.s.users.filter((u) => u.role !== 'morador');
const phone = (p: unknown) => {
  const d = String(p ?? '').replace(/\D/g, '');
  const full = /^\d{10,11}$/.test(d) ? `55${d}` : d;
  return /^55\d{10,11}$/.test(full) ? full : fail('Informe o WhatsApp com DDD (ex.: 11 99999-0000).');
};

export const ASSISTANT_HANDLERS: Record<string, Handler> = {
  assistant_team_options: (a) => { tenant(a); admin(); return team().map((u) => ({ user_id: u.id, role: u.role, full_name: u.full_name })); },
  assistant_links_list: (a) => {
    tenant(a); admin();
    const owner = team()[0];
    return links.map((l) => {
      const u = team().find((x) => x.id === l.user_id) || owner;
      return { ...l, user_id: u.id, full_name: u.full_name, role: u.role };
    });
  },
  assistant_link_save: (a) => {
    tenant(a); admin();
    if (!LEVELS.includes(a.p_level)) fail('Nível inválido.');
    if (!team().some((u) => u.id === a.p_user)) fail('Escolha uma pessoa ativa da equipe (síndico, administrador ou porteiro).');
    const p = phone(a.p_phone);
    if (links.some((l) => l.phone === p && l.id !== a.p_id)) fail('Este WhatsApp já está cadastrado neste condomínio.');
    const row = { id: a.p_id || crypto.randomUUID(), phone: p, level: a.p_level, label: a.p_label || null, active: a.p_active !== false, user_id: a.p_user, usable: a.p_active !== false, created_at: nowIso() };
    links = a.p_id ? links.map((l) => (l.id === a.p_id ? row : l)) : [...links, row];
    return { id: row.id, phone: row.phone, level: row.level, active: row.active };
  },
  assistant_link_delete: (a) => { tenant(a); admin(); links = links.filter((l) => l.id !== a.p_id); return null; },
};
