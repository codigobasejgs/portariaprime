import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { friendly, rpc } from '../../lib/api';
import { navigate, onLink, query } from '../../lib/router';
import { useSession } from '../../lib/session';
import { Alert, Button, Field, Input, Spinner } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

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
  useEffect(() => { if (session) navigate(nextPath(), true); }, [session]);

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

  return (
    <AuthLayout title="Entrar" subtitle="Acesse sua portaria, seu condomínio ou suas encomendas.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="E-mail"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Senha"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">Entrar</Button>
      </form>
      <div className="mt-6 space-y-2 text-sm">
        <p><a href="/recuperar-senha" onClick={onLink} className="text-secondary font-medium underline-offset-2 hover:underline">Esqueci minha senha</a></p>
        <p className="text-muted">Novo por aqui? <a href="/cadastro" onClick={onLink} className="text-secondary font-medium hover:underline">Cadastrar meu condomínio</a></p>
        <p className="text-muted text-xs">Morador ou porteiro: use o link de convite que o síndico enviou.</p>
      </div>
    </AuthLayout>
  );
}

export function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = query('next') || '/onboarding';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 10) return setError('Use uma senha com pelo menos 10 caracteres.');
    if (!accepted) return setError('É preciso aceitar os termos e a política de privacidade.');
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: { full_name: name.trim() }, emailRedirectTo: `${origin()}/entrar?next=${encodeURIComponent(next)}` },
    });
    setBusy(false);
    if (error) return setError(/registered|exists/i.test(error.message) ? 'Este e-mail já tem conta. Use "Entrar".' : friendly(error));
    setSent(true);
  };

  if (sent) {
    return (
      <AuthLayout title="Confirme seu e-mail">
        <Alert tone="success">Enviamos um link para <strong>{email}</strong>. Abra-o para ativar sua conta e continuar o cadastro.</Alert>
        <p className="mt-4 text-sm text-muted">Não chegou? Verifique o spam ou aguarde alguns minutos.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Criar conta" subtitle={next.startsWith('/convite') ? 'Crie sua conta para aceitar o convite.' : 'Primeiro mês grátis para o seu condomínio. Sem cartão para começar.'}>
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
      <p className="mt-6 text-sm text-muted">Já tem conta? <a href={`/entrar?next=${encodeURIComponent(next)}`} onClick={onLink} className="text-secondary font-medium hover:underline">Entrar</a></p>
    </AuthLayout>
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
