import React, { useEffect, useState } from 'react';
import { Building2, Package, ShieldCheck, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { friendly, rpc } from '../lib/api';
import { navigate, onLink } from '../lib/router';
import { useSession } from '../lib/session';
import { applyTheme, publicLogoUrl } from '../lib/theme';
import { Alert, Button, Field, Input, Select, Spinner } from '../components/ui';
import { usePwaInstall } from '../hooks/usePwaInstall';
import { DEFAULT_UNIT_LABELS } from '../lib/format';
import { BLOCK_PARAM, RELATIONS, blocksOf, Errors, fullName, maskPhone, normEmail, OTHER, phoneE164, SignupForm, UnitOpt, unitsOf, unitValue, validate } from '../lib/resident-signup';

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
  const { session, ctx, signOut } = useSession();
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  if (portal === undefined) return <Spinner />;
  if (!portal || portal.status !== 'active') return <PortalNotFound error={error || (portal ? 'Este portal está temporariamente indisponível.' : null)} />;
  const here = `/c/${slug}`;
  const next = encodeURIComponent(`${here}/solicitar`);
  // Já conectado com outra conta (equipe, outro condomínio): "Entrar" troca de conta; nunca abre o cadastro.
  const enter = async () => { if (session) await signOut(); navigate(`/entrar?next=${next}&portal=${slug}`); };
  // "Criar minha conta" abre direto o cadastro completo (conta + unidade + termo).
  const bloco = new URLSearchParams(location.search).get('bloco');
  const blocoQ = bloco && BLOCK_PARAM.test(bloco) ? `&bloco=${encodeURIComponent(bloco)}` : '';
  const signup = () => navigate(session ? `${here}/solicitar` : `/cadastro?next=${next}&portal=${slug}${blocoQ}`);
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  return (
    <PortalShell portal={portal}>
      <section aria-labelledby="portal-boas-vindas" className="space-y-2">
        <h2 id="portal-boas-vindas" className="text-2xl font-semibold">Bem-vindo(a) ao portal dos moradores</h2>
        <p className="text-muted">Acompanhe as encomendas e correspondências da sua unidade, receba avisos quando algo chegar e retire na portaria com o QR Code.</p>
      </section>

      {session && <p className="mt-4 text-sm text-muted">Conectado como <strong className="break-all">{ctx?.email}</strong>, sem acesso de morador aqui. "Entrar como morador" sai desta conta.</p>}
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

type Term = { version: string; title: string; content: string; hash: string };
type Units = { has_blocks: boolean; units: UnitOpt[]; group_label?: string; number_label?: string };
const EMPTY: SignupForm = { name: '', email: '', phone: '', block: '', unit: '', unitFree: '', relation: '', password: '', password2: '', accepted: false };

/** Formulário completo do morador, em uma etapa. account=true cria a conta (signUp); false = já logado. */
function ResidentForm({ slug, account, initial, notice, onDone }: {
  slug: string; account: boolean; initial?: Partial<SignupForm>; notice?: React.ReactNode;
  onDone: (r: { session: boolean; email: string }) => void;
}) {
  const [f, setF] = useState<SignupForm>({ ...EMPTY, ...initial, accepted: false }); // aceite sempre começa desmarcado
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState(false);
  // Termo vigente (global ou do condomínio): o envio leva o hash do texto exibido; o servidor confere.
  const [term, setTerm] = useState<Term | null | undefined>(undefined);
  const [units, setUnits] = useState<Units | null | undefined>(undefined);
  const [showTerm, setShowTerm] = useState(false);
  const loadTerm = () => supabase.rpc('privacy_term_current', { p_slug: slug }).then(({ data, error: e }) => setTerm(e ? null : (data || null)));
  useEffect(() => {
    void loadTerm();
    supabase.rpc('portal_units', { p_slug: slug }).then(({ data, error: e }) => setUnits(e ? null : (data || { has_blocks: false, units: [] })));
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bloco do QR que não existe neste condomínio: ignora.
  useEffect(() => {
    if (units?.has_blocks && f.block && !units.units.some((u) => u.block === f.block)) setF((x) => ({ ...x, block: '', unit: '' }));
  }, [units]); // eslint-disable-line react-hooks/exhaustive-deps
  // Rascunho/pedido anterior com unidade fora da lista: vira "não está na lista" + texto.
  useEffect(() => {
    if (!units?.units.length || !f.unit || f.unit === OTHER) return;
    if (!units.units.some((u) => u.label === f.unit && (u.block || '') === (units.has_blocks ? f.block : ''))) setF((x) => ({ ...x, unit: OTHER, unitFree: x.unit }));
  }, [units]); // eslint-disable-line react-hooks/exhaustive-deps

  if (term === undefined || units === undefined) return <Spinner />;
  const list = units?.units || [];
  const hasBlocks = !!units?.has_blocks;
  // Portal público: rótulos vêm de portal_units (sem TenantProvider). Antes da migration: padrão.
  const groupLabel = units?.group_label?.trim() || DEFAULT_UNIT_LABELS.group;
  const numberLabel = units?.number_label?.trim() || DEFAULT_UNIT_LABELS.number;
  const set =(k: keyof SignupForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: k === 'phone' ? maskPhone(e.target.value) : e.target.value });
  const here = `/c/${slug}/solicitar`;
  const login = `/entrar?next=${encodeURIComponent(here)}&portal=${slug}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validate(f, hasBlocks, list, !!term, account);
    setErrors(v); setError(null);
    if (Object.keys(v).length) { setError(v.term || 'Revise os campos destacados.'); return; }
    const name = fullName(f.name), phone = phoneE164(f.phone)!, block = hasBlocks ? f.block : null, unit = unitValue(f);
    setBusy(true);
    try {
      if (account) {
        const email = normEmail(f.email);
        // Dados do cadastro vão com a conta: o servidor guarda e cria o pedido no 1º login (sem pedir de novo).
        const { data, error: se } = await supabase.auth.signUp({ email, password: f.password, options: {
          data: { full_name: name, pp_signup: { slug, full_name: name, phone, block, unit, relation: f.relation, privacy_hash: term!.hash } },
          emailRedirectTo: `${location.origin}${login}`,
        } });
        if (se && !/registered|exists/i.test(se.message)) throw se;
        // Conta existente: com confirmação ligada o Auth não dá erro (identities vazio) para não revelar o e-mail.
        if (se || (data.user && !data.user.identities?.length)) {
          setError(<>Este e-mail já tem conta. <a href={login} onClick={onLink} className="underline font-medium">Entre com sua senha</a> para continuar o cadastro.</>);
          return;
        }
        onDone({ session: !!data.session, email });
      } else {
        await rpc('request_access', { p_slug: slug, p_full_name: name, p_phone: phone, p_block: block, p_unit: unit, p_privacy_hash: term!.hash });
        await rpc('access_request_set_relation', { p_slug: slug, p_relation: f.relation });
        onDone({ session: true, email: '' });
      }
    } catch (err: any) {
      setError(friendly(err));
      // Termo trocou enquanto a pessoa preenchia: recarrega o texto novo e exige nova marcação.
      if (/termo/i.test(String(err?.message || ''))) { setF((x) => ({ ...x, accepted: false })); void loadTerm(); }
    } finally { setBusy(false); }
  };

  const blocks = blocksOf(list);
  const opts = unitsOf(list, f.block, hasBlocks);
  return (
    <form onSubmit={submit} noValidate className="mt-4 space-y-4 max-w-md">
      {notice}
      <Field label="Nome completo" error={errors.name}><Input autoComplete="name" maxLength={120} value={f.name} onChange={set('name')} /></Field>
      {account && <Field label="E-mail" error={errors.email}><Input type="email" autoComplete="email" value={f.email} onChange={set('email')} /></Field>}
      <Field label="Celular / WhatsApp" hint="Para avisos de encomendas. Ex.: (11) 98888-7777" error={errors.phone}>
        <Input inputMode="tel" autoComplete="tel-national" value={f.phone} onChange={set('phone')} placeholder="(11) 98888-7777" /></Field>
      {list.length ? (
        <div className={hasBlocks ? 'grid grid-cols-2 gap-3' : ''}>
          {hasBlocks && <Field label={groupLabel} error={errors.block}>
            <Select value={f.block} onChange={(e) => setF({ ...f, block: e.target.value, unit: '' })}>
              <option value="">Selecione</option>{blocks.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select></Field>}
          <Field label={numberLabel} error={errors.unit}>
            <Select value={f.unit} onChange={set('unit')} disabled={hasBlocks && !f.block}>
              <option value="">{hasBlocks && !f.block ? `Escolha: ${groupLabel.toLocaleLowerCase('pt-BR')}` : 'Selecione'}</option>
              {opts.map((u) => <option key={`${u.block}|${u.label}`} value={u.label}>{u.label}</option>)}
              <option value={OTHER}>Minha unidade não está na lista</option>
            </Select></Field>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label={`${groupLabel} (se houver)`} error={errors.block}><Input maxLength={30} value={f.block} onChange={set('block')} /></Field>
          <Field label={numberLabel} error={errors.unit}><Input maxLength={30} value={f.unit} onChange={set('unit')} placeholder="101, Casa 3" /></Field>
        </div>
      )}
      {f.unit === OTHER && <Field label="Informe sua unidade" hint="A administração confere antes de aprovar." error={errors.unitFree}>
        <Input maxLength={30} value={f.unitFree} onChange={set('unitFree')} /></Field>}
      <Field label="Seu perfil na unidade" error={errors.relation}>
        <Select value={f.relation} onChange={set('relation')}><option value="">Selecione</option>{RELATIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
      {account && <>
        <Field label="Senha" hint="Mínimo de 10 caracteres." error={errors.password}><Input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
        <Field label="Confirme a senha" error={errors.password2}><Input type="password" autoComplete="new-password" value={f.password2} onChange={set('password2')} /></Field>
      </>}

      <fieldset className="rounded-xl border border-line p-4 space-y-3">
        <legend className="px-1 text-sm font-semibold">Termo de ciência e aceite — proteção de dados pessoais</legend>
        {!term ? <Alert tone="warning">Não foi possível carregar o termo de tratamento de dados. Verifique a conexão e recarregue a página.</Alert> : (<>
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
            <input type="checkbox" className="mt-0.5 w-5 h-5 shrink-0" checked={f.accepted} onChange={(e) => setF({ ...f, accepted: e.target.checked })} aria-invalid={!!errors.accepted} aria-describedby="termo-nota" />
            <span>Li e estou ciente do Termo de Tratamento de Dados Pessoais e das finalidades de utilização do Portal Portaria Prime.</span>
          </label>
          {errors.accepted && <p className="text-xs text-danger">{errors.accepted}</p>}
          <p id="termo-nota" className="text-xs text-muted">A marcação registra sua ciência e aceite deste documento, com data e hora do servidor e a versão lida. <a href="/privacidade" onClick={onLink} className="underline">Política de privacidade</a>.</p>
        </>)}
      </fieldset>

      {error && <div role="alert"><Alert tone="danger">{error}</Alert></div>}
      <Button type="submit" loading={busy} disabled={!term} className="w-full min-h-12">Enviar meu cadastro</Button>
      {account && <p className="text-sm text-muted text-center"><a href={login} onClick={onLink} className="text-secondary font-medium hover:underline">Já tenho conta — Entrar</a></p>}
    </form>
  );
}

/** /cadastro a partir do portal: conta + dados do morador + aceite, em uma tela só. */
/** Bloco vindo do QR do bloco (?bloco=); o formulário só o usa se existir entre os blocos do condomínio. */
const qrBlock = (): Partial<SignupForm> | undefined => {
  const b = new URLSearchParams(location.search).get('bloco');
  return b && BLOCK_PARAM.test(b) ? { block: b } : undefined;
};

export function ResidentSignupPage({ slug }: { slug: string }) {
  const { portal, error: perr } = usePortal(slug);
  // Sem sessão (confirmação de e-mail ligada): a tela de recebido sobrevive ao F5 nesta aba.
  const key = `pp_signup_sent:${slug}`;
  const [sent, setSent] = useState<string | null>(() => { try { return sessionStorage.getItem(key); } catch { return null; } });
  if (portal === undefined) return <Spinner />;
  if (!portal || portal.status !== 'active') return <PortalNotFound error={perr || (portal ? 'Este portal está temporariamente indisponível.' : null)} />;
  if (sent) return (
    <PortalShell portal={portal}><div className="max-w-md space-y-3">
      <h2 className="text-2xl font-semibold">Cadastro recebido com sucesso!</h2>
      <Alert tone="success">Falta só confirmar seu e-mail: enviamos um link para <strong>{sent}</strong>. Depois de confirmar, seu cadastro segue para a administração do {portal.name} — sem preencher nada de novo.</Alert>
      <p className="text-sm text-muted">Não chegou? Verifique o spam ou aguarde alguns minutos.</p>
    </div></PortalShell>
  );
  return (
    <PortalShell portal={portal}>
      <h2 className="text-2xl font-semibold">Criar minha conta</h2>
      <p className="mt-1 text-sm text-muted">Preencha uma vez. A administração do {portal.name} confere os dados e libera seu acesso.</p>
      <ResidentForm slug={slug} account initial={qrBlock()} onDone={({ session, email }) => {
        // Com sessão (confirmação automática): quem navega é o efeito do /cadastro ao ver a sessão no contexto
        // (navegar aqui chegaria antes dela e a rota sem sessão devolveria ao portal). Lá o cadastro é finalizado.
        if (session) return;
        try { sessionStorage.setItem(key, email); } catch { /* ok */ }
        setSent(email);
      }} />
    </PortalShell>
  );
}

/**
 * /c/{slug}/solicitar (logado): finaliza o cadastro feito no /cadastro e mostra a situação.
 * Formulário só para quem ainda não enviou, foi recusado/encerrado ou precisa rever algum dado.
 */
export function RequestAccessPage({ slug }: { slug: string }) {
  const { portal, error: perr } = usePortal(slug);
  const { session, ctx, loading, refresh } = useSession();
  const [req, setReq] = useState<any>(undefined);
  const [review, setReview] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const load = async () => {
    setChecking(true);
    try {
      // Idempotente: cria o pedido a partir do que foi preenchido no cadastro (se houver).
      const fin = await rpc<any>('resident_signup_finalize');
      setReview(fin?.status === 'needs_review' && fin.slug === slug ? fin : null);
      setReq(await rpc('my_access_request', { p_slug: slug }));
    } catch { setReq(null); } finally { setChecking(false); }
  };
  useEffect(() => { if (session) void load(); }, [session, slug]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { sessionStorage.removeItem(`pp_signup_sent:${slug}`); } catch { /* ok */ } }, [slug]);
  useEffect(() => {
    // Aprovado: entra no condomínio.
    if (req?.status === 'approved') { void refresh().then(() => navigate(`/c/${slug}/inicio`, true)); }
  }, [req?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (portal === undefined || loading || (session && req === undefined)) return <Spinner />;
  if (!portal || portal.status !== 'active') return <PortalNotFound error={perr} />;
  if (!session) { navigate(`/entrar?next=${encodeURIComponent(`/c/${slug}/solicitar`)}&portal=${slug}`, true); return <Spinner />; }
  if (ctx?.tenants.some((t) => t.slug === slug && t.role === 'morador')) { navigate(`/c/${slug}/inicio`, true); return <Spinner />; }

  if (req?.status === 'pending') return (
    <PortalShell portal={portal}><div className="max-w-md space-y-4">
      <h2 className="text-2xl font-semibold">Cadastro recebido com sucesso!</h2>
      <p className="text-sm">Seu cadastro no <strong>{portal.name}</strong> foi enviado para a administração. Assim que for aprovado, você recebe um aviso e entra com seu e-mail e senha.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm rounded-xl bg-surface-2 p-3">
        <dt className="text-muted">Situação</dt><dd className="font-medium">Aguardando aprovação</dd>
        {req.full_name && <><dt className="text-muted">Nome</dt><dd>{req.full_name}</dd></>}
        <dt className="text-muted">Unidade informada</dt><dd>{req.unit_text}</dd>
        {req.email && <><dt className="text-muted">E-mail</dt><dd className="break-all">{req.email}</dd></>}
        <dt className="text-muted">Enviado em</dt><dd>{new Date(req.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</dd>
        {req.privacy_version && <><dt className="text-muted">Termo de dados</dt><dd>versão {req.privacy_version} aceita</dd></>}
      </dl>
      <p className="text-sm text-muted">Enquanto isso, nenhuma informação do condomínio é exibida. Demorou? Fale com a portaria ou a administração.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Button onClick={load} loading={checking}>Acompanhar minha solicitação</Button>
        <Button variant="secondary" onClick={() => navigate(`/c/${slug}`)}>Voltar ao portal</Button>
      </div>
    </div></PortalShell>
  );

  // Recusado/encerrado: reaproveita o que já foi informado; revisão: o que o servidor guardou do cadastro.
  const d = review?.draft;
  const initial: Partial<SignupForm> = d ? { name: d.full_name, phone: maskPhone(d.phone || ''), block: d.block || '', unit: d.unit || '' }
    : req ? { name: req.full_name || '', phone: maskPhone(req.phone || ''), block: req.block_text || '', unit: req.unit || '' }
    : { name: String(session.user.user_metadata?.full_name || '') };
  return (
    <PortalShell portal={portal}>
      <h2 className="text-2xl font-semibold">{review ? 'Revise seu cadastro' : 'Cadastro de morador'}</h2>
      <p className="mt-1 text-sm text-muted">Conectado como <strong>{ctx?.email}</strong>. A administração confere os dados antes de liberar o acesso.</p>
      <ResidentForm key={JSON.stringify(initial)} slug={slug} account={false} initial={initial} onDone={() => void load()} notice={<>
        {review && <Alert tone="warning">Seu cadastro não pôde ser enviado: {review.reason} Confira os dados abaixo e marque novamente a ciência do termo.</Alert>}
        {!review && req?.status === 'revoked' && <Alert tone="warning">Seu acesso a este condomínio foi encerrado pela administração (por exemplo, mudança de unidade). Se ainda mora aqui, envie um novo pedido.</Alert>}
        {!review && req?.status === 'rejected' && <Alert tone="warning">Sua solicitação anterior não foi aprovada{req.reason ? `: ${req.reason}` : ''}. Revise os dados ou fale com a administração.</Alert>}
      </>} />
    </PortalShell>
  );
}
