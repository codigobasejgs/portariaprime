/**
 * POST /api/invitations/send  { tenantId, email, role, unitId?, permissions? }
 * Cria o convite COMO o gestor (a RPC valida permissão, unidade e papel) e envia
 * o link de uso único por e-mail. O token cru só existe neste trânsito.
 * Se o e-mail não estiver configurado, devolve o link para o gestor copiar —
 * nunca finge que enviou.
 */
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, rpcError } from '../_lib/supabase.js';
import { appUrl } from '../_lib/env.js';
import { sendEmail } from '../_lib/channels.js';
import { esc } from '../_lib/templates.js';

const ROLES: Record<string, string> = { admin: 'administrador(a)', porteiro: 'porteiro(a)', morador: 'morador(a)' };

export const POST = handler(async (request) => {
  const b = await readJson(request, 4096);
  if (!isUuid(b.tenantId) || !ROLES[b.role] || typeof b.email !== 'string') throw new HttpError(400, 'Dados do convite inválidos.');
  if (b.unitId != null && !isUuid(b.unitId)) throw new HttpError(400, 'Unidade inválida.');
  const perms = Array.isArray(b.permissions) ? b.permissions.filter((p: unknown) => typeof p === 'string').slice(0, 4) : [];

  const { client } = await requireUser(request);
  const { data, error } = await client.rpc('create_invitation', {
    p_tenant: b.tenantId, p_email: b.email, p_role: b.role, p_unit: b.unitId ?? null, p_permissions: perms,
  });
  if (error) rpcError(error);
  const { data: tenant } = await client.from('tenants').select('name').eq('id', b.tenantId).single();

  const link = `${appUrl()}/convite#${data.token}`;
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;background:#F7F5F0;padding:24px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:24px;color:#18283A">
<h2 style="margin-top:0">Convite — ${esc(tenant?.name)}</h2>
<p>Você foi convidado(a) como <strong>${esc(ROLES[b.role])}</strong> no sistema de encomendas do condomínio.</p>
<p>O convite vale por 7 dias e só funciona com este e-mail.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#101F30;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Aceitar convite</a></p>
<p style="color:#526174;font-size:12px">Se você não esperava este convite, ignore esta mensagem.</p>
<p style="color:#526174;font-size:11px">Tecnologia Portaria Prime</p></div></body></html>`;
  const sent = await sendEmail(b.email.trim().toLowerCase(), `Convite para ${tenant?.name || 'o condomínio'}`, html);
  return json({
    invitationId: data.invitation_id,
    expiresAt: data.expires_at,
    emailStatus: sent.status,
    // Só devolve o link se o e-mail não pôde ser enviado, para envio manual pelo gestor.
    ...(sent.status === 'accepted' ? {} : { manualLink: link, emailError: sent.error }),
  });
});
