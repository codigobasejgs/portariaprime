/**
 * Acessos da equipe com e-mail e senha definidos pelo síndico (sem convite por e-mail).
 *   POST /api/team/create   (vercel.json → /api/invitations/team-create)   { tenantId, email, fullName, role, permissions?, password }
 *   POST /api/team/password (vercel.json → /api/invitations/team-password) { tenantId, userId, password }
 * Autorização SEMPRE no banco com a sessão do síndico (permissão 'team', só delega o que tem, login recente).
 * A service role só cria/atualiza o usuário no Auth e conclui o vínculo já autorizado. Nada é enviado por e-mail;
 * a senha não é registrada em log nem devolvida.
 */
import { json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';

const PERMS = new Set(['team', 'approve', 'settings', 'billing']);

/** Senha forte o bastante para conta compartilhada de portaria (sem expor regra fraca ao navegador). */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p.length < 10) return 'Use uma senha com pelo menos 10 caracteres.';
  if (p.length > 72) return 'Use no máximo 72 caracteres.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Use letras e números na senha.';
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|senha|password)/i.test(p)) return 'Senha fácil demais. Escolha outra.';
  return null;
}

export async function team(request: Request, action: string) {
  const b = await readJson(request, 4096);
  if (!isUuid(b.tenantId)) throw new HttpError(400, 'Condomínio inválido.');
  const bad = passwordProblem(b.password);
  if (bad) throw new HttpError(400, bad);
  const { client, user } = await requireUser(request);
  const svc = serviceClient();

  if (action === 'create') {
    if (typeof b.email !== 'string' || typeof b.fullName !== 'string' || !['admin', 'porteiro'].includes(b.role)) throw new HttpError(400, 'Dados do acesso inválidos.');
    const perms = Array.isArray(b.permissions) ? [...new Set(b.permissions.filter((p: unknown) => typeof p === 'string' && PERMS.has(p as string)))] : [];
    const { data: chk, error } = await client.rpc('app_staff_account_check', {
      p_tenant: b.tenantId, p_email: b.email, p_full_name: b.fullName, p_role: b.role, p_permissions: b.role === 'admin' ? perms : [],
    });
    if (error) rpcError(error);
    const { data: created, error: ce } = await svc.auth.admin.createUser({
      email: chk.email, password: b.password, email_confirm: true, user_metadata: { full_name: b.fullName.trim().slice(0, 120) },
    });
    if (ce || !created.user) {
      if (/already|registered|exists/i.test(ce?.message || '')) throw new HttpError(409, 'Já existe uma conta com este e-mail.');
      if (/password/i.test(ce?.message || '')) throw new HttpError(400, 'Senha recusada pelo provedor. Use uma senha mais forte.');
      console.error('[team.create]', ce?.status || 'auth_error');
      throw new HttpError(502, 'Não foi possível criar o acesso agora. Tente novamente.');
    }
    const { data: link, error: le } = await svc.rpc('app_staff_account_link', { p_request: chk.request_id, p_user: created.user.id });
    if (le) {
      // Vínculo recusado: não deixa conta órfã com senha conhecida.
      await svc.auth.admin.deleteUser(created.user.id).catch(() => {});
      rpcError(le);
    }
    return json({ userId: link.user_id, role: link.role, email: chk.email });
  }

  if (action === 'password') {
    if (!isUuid(b.userId)) throw new HttpError(400, 'Acesso inválido.');
    const { error } = await client.rpc('app_staff_password_check', { p_tenant: b.tenantId, p_user: b.userId });
    if (error) rpcError(error);
    const { error: ue } = await svc.auth.admin.updateUserById(b.userId, { password: b.password });
    if (ue) {
      if (/password/i.test(ue.message || '')) throw new HttpError(400, 'Senha recusada pelo provedor. Use uma senha mais forte.');
      throw new HttpError(502, 'Não foi possível trocar a senha agora. Nenhuma alteração foi feita.');
    }
    // Registra e encerra as sessões abertas com a senha antiga (ex.: aparelho perdido), no banco.
    const { error: re } = await svc.rpc('app_staff_password_changed', { p_tenant: b.tenantId, p_user: b.userId, p_by: user.id });
    if (re) console.error('[team.password] registro', re.code || 'rpc_error');
    return json({ ok: true });
  }

  throw new HttpError(404, 'Ação desconhecida.');
}
