import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { friendly, rpc } from '../../lib/api';
import { navigate, onLink, query } from '../../lib/router';
import { useSession } from '../../lib/session';
import { Alert, Button, Field, Input, Spinner } from '../../components/ui';
import { AuthLayout } from './AuthLayout';
import { PortalShell, ResidentSignupPage, usePortal } from '../PortalPage';

/** Login/cadastro aberto a partir do portal: mantém a marca do condomínio. */
function Branded({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const slug = query('portal');
  return slug && /^[a-z0-9-]{3,48}$/.test(slug) ? <PortalBranded slug={slug} title={title} subtitle={subtitle}>{children}</PortalBranded>
    : <AuthLayout title={title} subtitle={subtitle}>{children}</AuthLayout>;
}
function PortalBranded({ slug, title, subtitle, children }: { slug: string; title: string; subtitle?: string; children: React.ReactNode }) {
  const { portal } = usePortal(slug);
  if (portal === undefined) return <Spinner />;
  if (!portal) return <AuthLayout title={title} subtitle={subtitle}>{children}</AuthLayout>;
  return <PortalShell portal={portal}><div className="max-w-sm mx-auto"><h2 className="text-2xl font-semibold">{title}</h2>
    {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}<div className="mt-6">{children}</div></div></PortalShell>;
}
import { track } from '../../lib/funnel';
import { isKioskApp } from '../../lib/kiosk-shift';

const origin = () => location.origin;

/** Volta para onde o usuário queria ir (somente caminho interno). */
function nextPath() {
  const n = query('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/app';
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { session } = useSession();
  // Destino lido uma vez: depois do 1º redirecionamento a URL já não tem ?next e cairia em /app.
  const [next] = useState(nextPath);
  useEffect(() => { if (session && location.pathname === '/entrar') navigate(next, true); }, [session, next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (error) {
      setError(/invalid login/i.test(error.message) ? 'E-mail ou senha incorretos.'
        : /not confirmed/i.test(error.message) ? 'Confirme seu e-mail pelo link que enviamos antes de entrar.' : friendly(error));
    }
  };

  const kiosk = isKioskApp();
  return (
    <Branded title={kiosk ? 'Entrar na portaria' : 'Entrar'} subtitle={kiosk ? 'Acesso da equipe: porteiro ou síndico deste condomínio.' : 'Acesse sua portaria, seu condomínio ou suas encomendas.'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="E-mail"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Senha"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">Entrar</Button>
      </form>
      <div className="mt-6 space-y-2 text-sm">
        <p><a href="/recuperar-senha" onClick={onLink} className="text-secondary font-medium underline-offset-2 hover:underline">Esqueci minha senha</a></p>
        {kiosk ? <p className="text-muted text-xs">Aparelho exclusivo da portaria. Moradores acessam pelo próprio celular, no link do portal.</p>
          : query('portal')
          ? <p className="text-muted">Mora aqui e não tem conta? <a href={`/cadastro?next=${encodeURIComponent(next)}&portal=${query('portal')}`} onClick={onLink} className="text-secondary font-medium hover:underline">Criar minha conta</a></p>
          : <><p className="text-muted">Novo por aqui? <a href="/cadastro" onClick={onLink} className="text-secondary font-medium hover:underline">Cadastrar meu condomínio</a></p>
            <p className="text-muted text-xs">Morador: abra o link do portal do seu condomínio para criar sua conta.</p></>}
      </div>
    </Branded>
  );
}

export function SignupPage() {
  // Quiosque não cria conta (nem de morador, nem de condomínio): equipe já existe e entra pelo login.
  if (isKioskApp()) return <KioskNoSignup />;
  // Morador vindo do portal: cadastro completo em uma etapa (dados da unidade + termo junto com a conta).
  const slug = query('portal');
  const n = query('next') || '';
  if (slug && /^[a-z0-9-]{3,48}$/.test(slug) && n === `/c/${slug}/solicitar`) return <ResidentSignup slug={slug} />;
  return <AccountSignup />;
}

function KioskNoSignup() {
  useEffect(() => { const p = query('portal'); navigate(`/entrar${p && /^[a-z0-9-]{3,48}$/.test(p) ? `?portal=${p}` : ''}`, true); }, []);
  return <Spinner />;
}

function ResidentSignup({ slug }: { slug: string }) {
  const { session } = useSession();
  // Já conectado: a página do pedido mostra a situação (ou só o que falta).
  useEffect(() => { if (session) navigate(`/c/${slug}/solicitar`, true); }, [session, slug]);
  return session ? <Spinner /> : <ResidentSignupPage slug={slug} />;
}

function AccountSignup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [next] = useState(() => { const n = query('next'); return n && n.startsWith('/') && !n.startsWith('//') ? n : '/onboarding'; });
  const resident = next.startsWith('/convite') || /^\/c\/[a-z0-9-]+\/solicitar$/.test(next);
  const { session } = useSession();
  useEffect(() => { if (!resident) track('signup_started'); }, [resident]);
  // Com confirmação automática (produção) o signUp já devolve sessão e o app remonta esta página:
  // sem este desvio a pessoa via o formulário vazio de novo. Conta já conectada segue para o destino.
  useEffect(() => { if (session && location.pathname === '/cadastro') navigate(next, true); }, [session, next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 10) return setError('Use uma senha com pelo menos 10 caracteres.');
    if (!accepted) return setError('É preciso aceitar os termos e a política de privacidade.');
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: { full_name: name.trim() }, emailRedirectTo: `${origin()}/entrar?next=${encodeURIComponent(next)}${query('portal') ? `&portal=${query('portal')}` : ''}` },
    });
    setBusy(false);
    if (error) return setError(/registered|exists/i.test(error.message) ? 'Este e-mail já tem conta. Use "Entrar".' : friendly(error));
    if (!resident) track('signup_completed');
    if (data.session) return navigate(next, true);
    setSent(true);
  };

  if (sent) {
    return (
      <Branded title="Confirme seu e-mail">
        <Alert tone="success">Enviamos um link para <strong>{email}</strong>. Abra-o para ativar sua conta e continuar o cadastro.</Alert>
        <p className="mt-4 text-sm text-muted">Não chegou? Verifique o spam ou aguarde alguns minutos.</p>
      </Branded>
    );
  }

  return (
    <Branded title="Criar conta" subtitle={resident ? 'Crie sua conta. Depois você informa sua unidade para a administração aprovar.' : 'Primeiro mês grátis para o seu condomínio. Sem cartão para começar.'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Seu nome"><Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="E-mail"><Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Senha" hint="Mínimo de 10 caracteres."><Input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <label className="flex gap-2 text-sm text-muted">
          <input type="checkbox" className="mt-1 w-4 h-4" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>Li e aceito os <a href="/termos" target="_blank" className="underline">Termos de Uso</a> e a <a href="/privacidade" target="_blank" className="underline">Política de Privacidade</a>.</span>
        </label>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">Criar conta</Button>
      </form>
      <p className="mt-6 text-sm text-muted">Já tem conta? <a href={`/entrar?next=${encodeURIComponent(next)}${query('portal') ? `&portal=${query('portal')}` : ''}`} onClick={onLink} className="text-secondary font-medium hover:underline">Entrar</a></p>
    </Branded>
  );
}

export function RecoverPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${origin()}/nova-senha` });
    setBusy(false);
    setSent(true); // mesma resposta exista ou não a conta (sem enumeração)
  };
  return (
    <AuthLayout title="Recuperar senha">
      {sent ? <Alert tone="success">Se houver uma conta com esse e-mail, enviamos um link para criar nova senha.</Alert> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-mail"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" loading={busy} className="w-full">Enviar link</Button>
        </form>
      )}
      <p className="mt-6 text-sm"><a href="/entrar" onClick={onLink} className="text-secondary hover:underline">Voltar para entrar</a></p>
    </AuthLayout>
  );
}

export function NewPasswordPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { session, loading } = useSession();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 10) return setError('Use pelo menos 10 caracteres.');
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(friendly(error));
    navigate('/app', true);
  };
  if (loading) return <Spinner />;
  return (
    <AuthLayout title="Nova senha">
      {!session ? <Alert tone="warning">Link inválido ou expirado. Peça um novo em “Esqueci minha senha”.</Alert> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Nova senha" hint="Mínimo de 10 caracteres."><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={busy} className="w-full">Salvar senha</Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** /convite#<token>: token no fragmento (não vai para logs de servidor). */
export function InvitePage() {
  const token = location.hash.slice(1);
  const { session, ctx, refresh, loading } = useSession();
  const [preview, setPreview] = useState<{ tenant_name: string; role: string; valid: boolean } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) rpc('invitation_preview', { p_token: token }).then(setPreview).catch(() => setPreview(null));
    else setPreview(null);
    try { sessionStorage.setItem('pp_invite', token); } catch { /* ok */ }
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<{ slug: string; role: string }>('accept_invitation', { p_token: token });
      try { sessionStorage.removeItem('pp_invite'); } catch { /* ok */ }
      await refresh();
      navigate(`/c/${r.slug}`, true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const ROLE: Record<string, string> = { admin: 'administrador(a)', porteiro: 'porteiro(a)', morador: 'morador(a)' };
  const here = `/convite${location.hash}`;
  if (preview === undefined || loading) return <Spinner />;
  return (
    <AuthLayout title="Convite" subtitle={preview ? `${preview.tenant_name} convidou você como ${ROLE[preview.role] || preview.role}.` : undefined}>
      {!preview || !preview.valid ? (
        <Alert tone="warning">Convite inválido, expirado ou já utilizado. Peça um novo ao síndico.</Alert>
      ) : !session ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Entre ou crie sua conta com o mesmo e-mail que recebeu o convite.</p>
          <Button className="w-full" onClick={() => navigate(`/cadastro?next=${encodeURIComponent(here)}`)}>Criar conta</Button>
          <Button variant="secondary" className="w-full" onClick={() => navigate(`/entrar?next=${encodeURIComponent(here)}`)}>Já tenho conta</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Conectado como <strong>{ctx?.email}</strong>.</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button className="w-full" loading={busy} onClick={accept}>Aceitar convite</Button>
        </div>
      )}
    </AuthLayout>
  );
}
