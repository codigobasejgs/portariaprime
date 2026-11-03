import React, { useEffect, useState } from 'react';
import { Building2, Package, ShieldCheck, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { friendly, rpc } from '../lib/api';
import { navigate, onLink } from '../lib/router';
import { useSession } from '../lib/session';
import { applyTheme, publicLogoUrl } from '../lib/theme';
import { Alert, Button, Field, Input, Spinner } from '../components/ui';
import { usePwaInstall } from '../hooks/usePwaInstall';

export interface Portal { slug: string; name: string; logo_path: string | null; color_primary: string | null; color_secondary: string | null; color_accent: string | null; status: string }

/** Marca pública do condomínio (só nome, logo e cores). */
export function usePortal(slug: string) {
  const [p, setP] = useState<Portal | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    supabase.rpc('portal_info', { p_slug: slug }).then(({ data, error }) => {
      if (!on) return;
      if (error) { setError('Não foi possível carregar o portal. Verifique a conexão.'); setP(null); return; }
      setP(data || null);
      if (data) applyTheme({ ...data, theme: 'light' } as any);
    });
    return () => { on = false; applyTheme(null); };
  }, [slug]);
  return { portal: p, error };
}

export function PortalShell({ portal, children }: { portal: Portal; children: React.ReactNode }) {
  const logo = publicLogoUrl(portal.logo_path);
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="bg-primary text-primary-fg">
        <div className="max-w-3xl mx-auto px-4 py-8 flex items-center gap-4">
          {logo ? <img src={logo} alt="" className="h-16 w-16 rounded-xl bg-white object-contain p-1" />
            : <span className="h-16 w-16 rounded-xl bg-white/15 grid place-items-center"><Building2 className="w-8 h-8" /></span>}
          <div className="min-w-0"><p className="text-xs uppercase tracking-wide opacity-80">Portal do condomínio</p><h1 className="text-2xl font-semibold truncate">{portal.name}</h1></div>
        </div>
      </header>
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-8">{children}</main>
      <footer className="text-center text-[11px] text-muted pb-6">Tecnologia Portaria Prime</footer>
    </div>
  );
}

export function PortalNotFound({ error }: { error?: string | null }) {
  return (
    <main className="min-h-dvh grid place-items-center px-4"><div className="max-w-sm text-center space-y-3">
      <h1 className="text-xl font-semibold">{error ? 'Portal indisponível' : 'Condomínio não encontrado'}</h1>
      <p className="text-sm text-muted">{error || 'Confira o endereço com a administração do seu condomínio.'}</p>
      <a href="/" onClick={onLink} className="underline text-sm">Ir para Portaria Prime</a>
    </div></main>
  );
}

/**
 * /c/{slug} sem vínculo: portal exclusivo do morador (é o link divulgado aos moradores).
 * Administração e portaria NÃO aparecem aqui: entram pelo login comum (/entrar) e o servidor decide
 * o papel; esconder os cartões não é a proteção — cada rota e RPC continua exigindo o vínculo certo.
 */
export function PortalPage({ slug }: { slug: string }) {
  const { portal, error } = usePortal(slug);
  const { session } = useSession();
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  if (portal === undefined) return <Spinner />;
  if (!portal || portal.status !== 'active') return <PortalNotFound error={error || (portal ? 'Este portal está temporariamente indisponível.' : null)} />;
  const here = `/c/${slug}`;
  const next = encodeURIComponent(`${here}/solicitar`);
  const enter = () => navigate(session ? `${here}/solicitar` : `/entrar?next=${next}&portal=${slug}`);
  const signup = () => navigate(session ? `${here}/solicitar` : `/cadastro?next=${next}&portal=${slug}`);
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  return (
    <PortalShell portal={portal}>
      <section aria-labelledby="portal-boas-vindas" className="space-y-2">
        <h2 id="portal-boas-vindas" className="text-2xl font-semibold">Bem-vindo(a) ao portal dos moradores</h2>
        <p className="text-muted">Acompanhe as encomendas e correspondências da sua unidade, receba avisos quando algo chegar e retire na portaria com o QR Code.</p>
      </section>

      <div className="mt-6 grid sm:grid-cols-2 gap-3">
        <Button onClick={enter} className="w-full min-h-14 text-base">Entrar como morador</Button>
        <Button variant="secondary" onClick={signup} className="w-full min-h-14 text-base">Criar minha conta</Button>
      </div>
      <p className="mt-3 text-sm"><a href={`/recuperar-senha?portal=${slug}`} onClick={onLink} className="underline text-secondary">Esqueci minha senha</a></p>

      <ul className="mt-8 grid sm:grid-cols-3 gap-3 text-sm">
        {([
          [Package, 'Aviso de chegada', 'Você é avisado quando uma encomenda chega para a sua unidade.'],
          [ShieldCheck, 'Retirada segura', 'Retire com o QR Code de uso único, validado pela portaria.'],
          [Users, 'Cadastro aprovado', 'A administração confere os dados antes de liberar o acesso.'],
        ] as [React.ElementType, string, string][]).map(([Icon, t, d]) => (
          <li key={t} className="rounded-2xl border border-line bg-surface p-4">
            <Icon className="w-5 h-5 text-primary" aria-hidden /><p className="mt-2 font-semibold">{t}</p><p className="text-muted">{d}</p>
          </li>
        ))}
      </ul>

      {!isInstalled && (
        <section aria-labelledby="portal-instalar" className="mt-8 rounded-2xl bg-surface-2 p-5 space-y-2">
          <h3 id="portal-instalar" className="font-semibold">Instale na tela inicial</h3>
          {isInstallable
            ? <><p className="text-sm text-muted">Abra o portal como um aplicativo, direto da tela inicial do celular.</p><Button variant="secondary" onClick={() => promptInstall()}>Instalar aplicativo</Button></>
            : <p className="text-sm text-muted">{ios
              ? 'No iPhone ou iPad: toque em Compartilhar e depois em “Adicionar à Tela de Início”.'
              : 'No Android: abra o menu do navegador (⋮) e escolha “Instalar app” ou “Adicionar à tela inicial”.'}</p>}
        </section>
      )}

      <p className="mt-8 text-xs text-muted">Seus dados são usados para identificar você, validar o cadastro e controlar encomendas e correspondências. <a href="/privacidade" onClick={onLink} className="underline">Política de privacidade</a>.
        {' '}Equipe da portaria ou administração? <a href="/entrar" onClick={onLink} className="underline">Acesse pelo login</a>.</p>
    </PortalShell>
  );
}

/** Solicitação de vínculo (conta já criada e verificada). Mesma resposta exista a unidade ou não. */
export function RequestAccessPage({ slug }: { slug: string }) {
  const { portal, error: perr } = usePortal(slug);
  const { session, ctx, loading, refresh } = useSession();
  const [req, setReq] = useState<any>(undefined);
  const [f, setF] = useState({ full_name: '', phone: '', block: '', unit: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Termo vigente do condomínio: o envio leva o hash do texto exibido; o servidor confere com a versão publicada.
  const [term, setTerm] = useState<{ version: string; title: string; content: string; hash: string } | null | undefined>(undefined);
  const [accepted, setAccepted] = useState(false);
  const [showTerm, setShowTerm] = useState(false);
  const load = () => rpc('my_access_request', { p_slug: slug }).then(setReq).catch(() => setReq(null));
  useEffect(() => { if (session) void load(); }, [session, slug]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let on = true;
    supabase.rpc('privacy_term_current', { p_slug: slug }).then(({ data, error: e }) => { if (on) setTerm(e ? null : (data || null)); });
    return () => { on = false; };
  }, [slug]);
  useEffect(() => {
    // Aprovado: entra no condomínio.
    if (req?.status === 'approved') { void refresh().then(() => navigate(`/c/${slug}/inicio`, true)); }
  }, [req?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (portal === undefined || loading || (session && req === undefined)) return <Spinner />;
  if (!portal || portal.status !== 'active') return <PortalNotFound error={perr} />;
  if (!session) { navigate(`/entrar?next=${encodeURIComponent(`/c/${slug}/solicitar`)}&portal=${slug}`, true); return <Spinner />; }
  if (ctx?.tenants.some((t) => t.slug === slug && t.role === 'morador')) { navigate(`/c/${slug}/inicio`, true); return <Spinner />; }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!term || !accepted) { setError('Leia e marque a ciência do termo de tratamento de dados para enviar o cadastro.'); return; }
    setBusy(true); setError(null);
    try {
      await rpc('request_access', { p_slug: slug, p_full_name: f.full_name, p_phone: f.phone || null, p_block: f.block || null, p_unit: f.unit, p_privacy_hash: term.hash });
      await load();
    } catch (err: any) {
      setError(friendly(err));
      // Termo trocou enquanto a pessoa preenchia: recarrega o texto novo e exige nova marcação.
      if (/termo/i.test(String(err?.message || ''))) {
        setAccepted(false);
        const { data } = await supabase.rpc('privacy_term_current', { p_slug: slug });
        setTerm(data || null);
      }
    } finally { setBusy(false); }
  };
  return (
    <PortalShell portal={portal}>
      <h2 className="text-xl font-semibold">{req?.status === 'pending' ? 'Cadastro aguardando aprovação' : 'Cadastro de morador'}</h2>
      {req?.status === 'pending' ? (
        <div className="mt-4 space-y-3 max-w-md">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm rounded-xl bg-surface-2 p-3">
            <dt className="text-muted">Unidade informada</dt><dd className="font-medium">{req.unit_text}</dd>
            <dt className="text-muted">Enviado em</dt><dd>{new Date(req.created_at).toLocaleDateString('pt-BR')}</dd>
            {req.privacy_version && <><dt className="text-muted">Termo de dados</dt><dd>versão {req.privacy_version} aceita</dd></>}
          </dl>
          <p className="text-sm"><strong>Próximo passo:</strong> a administração confere seus dados. Você recebe um e-mail com a decisão. Enquanto isso, nenhuma informação do condomínio é exibida.</p>
          <p className="text-sm text-muted">Demorou? Fale com a portaria ou a administração do condomínio.</p>
          <Button variant="secondary" onClick={load}>Verificar novamente</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-4 max-w-md">
          {req?.status === 'revoked' && <Alert tone="warning">Seu acesso a este condomínio foi encerrado pela administração (por exemplo, mudança de unidade). Se ainda mora aqui, envie um novo pedido.</Alert>}
          {req?.status === 'rejected' && <Alert tone="warning">Sua solicitação anterior não foi aprovada{req.reason ? `: ${req.reason}` : ''}. Revise os dados ou fale com a administração.</Alert>}
          <p className="text-sm text-muted">Conectado como <strong>{ctx?.email}</strong>. A administração confere os dados antes de liberar o acesso.</p>
          <Field label="Nome completo"><Input required minLength={2} maxLength={120} autoComplete="name" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
          <Field label="Celular com DDD (para avisos no WhatsApp)"><Input inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="11 99999-0000" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bloco/Torre (se houver)"><Input maxLength={30} value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} /></Field>
            <Field label="Unidade"><Input required maxLength={30} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="101, 12B, Casa 3" /></Field>
          </div>

          <fieldset className="rounded-xl border border-line p-4 space-y-3">
            <legend className="px-1 text-sm font-semibold">Termo de ciência e aceite — proteção de dados pessoais</legend>
            {term === undefined ? <Spinner /> : !term ? (
              <Alert tone="warning">O condomínio ainda não publicou o termo de tratamento de dados. O cadastro fica disponível assim que a administração publicar. Fale com a portaria ou a administração.</Alert>
            ) : (<>
              <p className="text-sm text-muted">Antes de enviar, leia como seus dados são tratados (versão {term.version}).</p>
              <button type="button" className="text-sm font-medium underline text-secondary" aria-expanded={showTerm} aria-controls="termo-texto" onClick={() => setShowTerm(!showTerm)}>
                {showTerm ? 'Ocultar o termo' : 'Ler o termo completo'}
              </button>
              {showTerm && (
                <div id="termo-texto" tabIndex={0} role="region" aria-label={term.title} className="max-h-[50vh] overflow-y-auto rounded-lg bg-surface-2 p-3 text-sm space-y-2">
                  <p className="font-semibold">{term.title}</p>
                  {term.content.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
                </div>
              )}
              <label className="flex gap-3 items-start text-sm">
                <input type="checkbox" className="mt-0.5 w-5 h-5 shrink-0" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required aria-describedby="termo-nota" />
                <span>Li e estou ciente do Termo de Tratamento de Dados Pessoais e das finalidades de utilização do Portal Portaria Prime.</span>
              </label>
              <p id="termo-nota" className="text-xs text-muted">A marcação registra sua ciência e aceite deste documento, com data e hora do servidor e a versão lida. <a href="/privacidade" onClick={onLink} className="underline">Política de privacidade</a>.</p>
            </>)}
          </fieldset>

          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={!term || !accepted} className="w-full">Enviar solicitação</Button>
        </form>
      )}
    </PortalShell>
  );
}
