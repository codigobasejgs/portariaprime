import { HttpError, isUuid, json, readJson, sha256Hex } from '../_lib/http.js';
import { requireUser, rpcError, serviceClient } from '../_lib/supabase.js';
import { documentValue, validDescriptor } from '../_lib/porter-face.js';
import { passwordProblem } from './_team.js';

const denied = () => new HttpError(403, 'Não foi possível verificar o acesso. Confira os dados, aprovação e bloqueio de 15 minutos.');
function photoBytes(v: unknown): Uint8Array {
  if (typeof v !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 700000) throw new HttpError(400, 'Foto JPEG inválida (máximo 500 KB).');
  const b = Buffer.from(v.slice(v.indexOf(',') + 1), 'base64');
  if (b.length < 100 || b.length > 500000 || b[0] !== 255 || b[1] !== 216 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217) throw new HttpError(400, 'Foto JPEG inválida.');
  return b;
}
async function upload(svc: ReturnType<typeof serviceClient>, tenant: string, bytes: Uint8Array) {
  const path = `${tenant}/staff-face/${crypto.randomUUID()}.jpg`;
  const { error } = await svc.storage.from('tenant-private').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new HttpError(502, 'Falha ao guardar a foto. Tente novamente.');
  return path;
}
export async function porter(request: Request, action: string) {
  const b = await readJson(request, 750000);
  const svc = serviceClient();
  if (action === 'photo') {
    if (!isUuid(b.tenantId) || !isUuid(b.userId) || (b.attemptId && !isUuid(b.attemptId))) throw new HttpError(400, 'Foto inválida.');
    const { client } = await requireUser(request);
    const { data: path, error } = await client.rpc('porter_photo_authorize', { p_tenant: b.tenantId, p_user: b.userId, p_attempt: b.attemptId || null });
    if (error) rpcError(error);
    const { data, error: se } = await svc.storage.from('tenant-private').createSignedUrl(path, 60);
    if (se) throw new HttpError(502, 'Foto indisponível.');
    return json({ url: data.signedUrl });
  }
  if (typeof b.slug !== 'string' || !/^[a-z0-9-]{3,48}$/.test(b.slug)) throw new HttpError(400, 'Condomínio inválido.');
  if (action === 'preview' || action === 'signup') {
    if (typeof b.token !== 'string' || !/^[a-f0-9]{64}$/.test(b.token)) throw denied();
    const { data: preview, error } = await svc.rpc('porter_signup_preview', { p_slug: b.slug, p_token: b.token });
    if (error) rpcError(error);
    if (action === 'preview') return json(preview);
    const bad = passwordProblem(b.password);
    if (bad) throw new HttpError(400, bad);
    if (typeof b.fullName !== 'string' || b.fullName.trim().length < 2 || b.fullName.length > 120 || typeof b.email !== 'string' || b.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)
      || typeof b.phone !== 'string' || !/^\d{10,13}$/.test(b.phone.replace(/\D/g, ''))) throw new HttpError(400, 'Nome, telefone ou e-mail inválidos.');
    if (b.consent !== true || b.termHash !== preview.term.hash) throw new HttpError(400, 'Leia e aceite o termo biométrico vigente.');
    if (!validDescriptor(b.descriptor) || b.liveness !== true) throw new HttpError(400, 'Conclua a captura facial.');
    let doc: string;
    try { doc = documentValue(b.documentType, b.document); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const bytes = photoBytes(b.photo);
    const hash = await sha256Hex(`${preview.tenant_id}:${b.documentType}:${doc}`);
    const { data: created, error: ce } = await svc.auth.admin.createUser({ email: b.email.trim().toLowerCase(), password: b.password, email_confirm: true, user_metadata: { full_name: b.fullName.trim() } });
    if (ce || !created.user) throw new HttpError(409, 'Não foi possível criar a conta. Confira o e-mail ou fale com o síndico.');
    let path: string | null = null;
    let linked = false;
    try {
      path = await upload(svc, preview.tenant_id, bytes);
      const { data, error: le } = await svc.rpc('porter_signup_finish', { p_slug: b.slug, p_token: b.token, p_user: created.user.id,
        p_data: { fullName: b.fullName.trim(), documentType: b.documentType, documentHash: hash, documentMasked: `${b.documentType} •••${doc.slice(-4)}`, phone: b.phone.replace(/\D/g, '') },
        p_descriptor: b.descriptor, p_photo: path, p_hash: b.termHash,
        // Vercel overwrites this header; never trust a caller-provided generic x-forwarded-for.
        p_ip: request.headers.get('x-vercel-forwarded-for') || 'unavailable', p_ua: request.headers.get('user-agent') || 'unavailable' });
      if (le) rpcError(le);
      linked = true;
      return json(data);
    } finally {
      if (!linked) {
        if (path) { const { error: de } = await svc.storage.from('tenant-private').remove([path]); if (de) await svc.from('porter_photo_deletions').upsert({ path }); }
        const { error: de } = await svc.auth.admin.deleteUser(created.user.id);
        if (de) console.error('[porter] orphan auth cleanup failed', de.status);
      }
    }
  }
  if (action !== 'login') throw new HttpError(404, 'Ação desconhecida.');
  if (typeof b.password !== 'string' || b.password.length > 72 || !['face', 'password'].includes(b.method)) throw denied();
  let doc: string;
  try { doc = documentValue(b.documentType, b.document); } catch { throw denied(); }
  const { data: t } = await svc.from('tenants').select('id').eq('slug', b.slug).eq('status', 'active').maybeSingle();
  if (!t) throw denied();
  const hash = await sha256Hex(`${t.id}:${b.documentType}:${doc}`);
  const { data: identity } = await svc.from('porter_identities').select('user_id').eq('tenant_id', t.id).eq('document_hash', hash).maybeSingle();
  if (!identity) throw denied();
  const { data: account } = await svc.auth.admin.getUserById(identity.user_id);
  if (!account.user?.email) throw denied();
  // Separate instance: signIn must NEVER replace the service role token of svc.
  const auth = serviceClient();
  const { data: login, error: pe } = await auth.auth.signInWithPassword({ email: account.user.email, password: b.password });
  const passwordOk = !pe && login.user?.id === identity.user_id && !!login.session;
  let path: string | null = null;
  let recorded = false;
  let accepted = false;
  try {
    if (passwordOk && b.method === 'face') {
      if (!validDescriptor(b.descriptor) || b.liveness !== true) throw new HttpError(400, 'Conclua a captura facial.');
      path = await upload(svc, t.id, photoBytes(b.photo));
    }
    const { data: checked, error } = await svc.rpc('porter_login_check', { p_tenant: t.id, p_user: identity.user_id, p_document_hash: hash,
      p_descriptor: passwordOk && b.method === 'face' ? b.descriptor : null, p_photo: path, p_method: passwordOk ? b.method : 'password_failed' });
    if (error) rpcError(error);
    recorded = true;
    if (!passwordOk || !checked.ok || !login.session) throw denied();
    const sessionId = JSON.parse(Buffer.from(login.session.access_token.split('.')[1], 'base64url').toString()).session_id;
    if (typeof sessionId !== 'string') throw denied();
    const { data: shift, error: se } = await svc.rpc('porter_shift_open', { p_attempt: checked.attempt_id, p_session: sessionId });
    if (se) rpcError(se);
    accepted = true;
    return json({ access_token: login.session.access_token, refresh_token: login.session.refresh_token, shift });
  } finally {
    if (path && !recorded) { const { error } = await svc.storage.from('tenant-private').remove([path]); if (error) await svc.from('porter_photo_deletions').upsert({ path }); }
    if (!accepted && login.session) await svc.auth.admin.signOut(login.session.access_token, 'local');
  }
}
