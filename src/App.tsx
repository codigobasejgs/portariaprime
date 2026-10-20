import React, { lazy, Suspense, useEffect } from 'react';
import { configError } from './lib/supabase';
import { SessionProvider, useSession } from './lib/session';
import { TenantProvider } from './lib/tenant';
import { matchTenant, navigate, onLink, usePath } from './lib/router';
import { Alert, Button, Card, Spinner, Toaster } from './components/ui';
import { PortariaPrimeLogo } from './components/Brand';
import { LoginPage, SignupPage, RecoverPage, NewPasswordPage, InvitePage } from './pages/auth/AuthPages';
import { TenantShell } from './pages/tenant/TenantShell';

const Onboarding = lazy(() => import('./pages/Onboarding').then(m => ({ default: m.OnboardingPage })));
const Portaria = lazy(() => import('./pages/tenant/portaria/PortariaPage').then(m => ({ default: m.PortariaPage })));
const Morador = lazy(() => import('./pages/tenant/MoradorPage').then(m => ({ default: m.MoradorPage })));
const Avisos = lazy(() => import('./pages/tenant/MoradorPage').then(m => ({ default: m.AvisosPage })));
const Painel = lazy(() => import('./pages/tenant/PainelPage').then(m => ({ default: m.PainelPage })));
const Pessoas = lazy(() => import('./pages/tenant/PessoasPage').then(m => ({ default: m.PessoasPage })));
const Config = lazy(() => import('./pages/tenant/ConfigPage').then(m => ({ default: m.ConfigPage })));
const Assinatura = lazy(() => import('./pages/tenant/AssinaturaPage').then(m => ({ default: m.AssinaturaPage })));
const Retorno = lazy(() => import('./pages/tenant/AssinaturaPage').then(m => ({ default: m.CheckoutReturnPage })));
const Totem = lazy(() => import('./pages/TotemPage'));
const Admin = lazy(() => import('./pages/AdminPage'));
const Ajuda = lazy(() => import('./pages/HelpPage'));

function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, true); }, [to]);
  return <Spinner />;
}

function Routes() {
  const path = usePath();
  const { ctx, session, loading, error, refresh, signOut } = useSession();
  const route = matchTenant(path);
  if (path === '/termos' || path === '/privacidade') return <LegalPage privacy={path === '/privacidade'} />;
  if (configError) return <main className="max-w-lg mx-auto p-6"><PortariaPrimeLogo /><Alert tone="danger">{configError}</Alert></main>;
  if (route?.area === 'totem') return <Totem slug={route.slug} />;
  if (loading) return <Spinner />;
  // A raiz é acesso ao sistema. Landing comercial permanece bloqueada pelo gate.
  if (path === '/') return <Redirect to={session ? '/app' : '/entrar'} />;
  if (path === '/entrar') return <LoginPage />;
  if (path === '/cadastro') return <SignupPage />;
  if (path === '/recuperar-senha') return <RecoverPage />;
  if (path === '/nova-senha') return <NewPasswordPage />;
  if (path === '/convite') return <InvitePage />;
  if (!session) return <Redirect to={`/entrar?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  if (error || !ctx) return <main className="max-w-lg mx-auto p-6 space-y-4"><Alert tone="danger">{error || 'Não foi possível carregar seus vínculos.'}</Alert><Button onClick={refresh}>Tentar novamente</Button><Button variant="ghost" onClick={signOut}>Sair</Button></main>;
  if (path === '/onboarding') return <Onboarding />;
  if (path === '/checkout/retorno') return <Retorno />;
  if (path === '/admin') return ctx.platform_admin ? <Admin /> : <Alert tone="danger">Acesso restrito à administração da plataforma.</Alert>;
  if (path === '/app') return <main className="max-w-2xl mx-auto px-4 py-10 space-y-5">
    <PortariaPrimeLogo /><h1 className="text-2xl font-semibold">Escolha o condomínio</h1>
    {ctx.tenants.length === 0 && <Alert>Nenhum vínculo ativo. Use o convite recebido ou cadastre seu condomínio.</Alert>}
    {Array.from(new Map(ctx.tenants.map(t => [t.tenant_id, t])).values()).map(t => <Card key={t.tenant_id}>
      <a className="font-semibold underline" href={`/c/${t.slug}`} onClick={onLink}>{t.name}</a>
    </Card>)}
    <Button onClick={() => navigate('/onboarding')}>Cadastrar condomínio</Button>
    {ctx.platform_admin && <Button variant="secondary" onClick={() => navigate('/admin')}>Administrar plataforma</Button>}
    <Button variant="ghost" onClick={signOut}>Sair</Button>
  </main>;
  if (route) {
    const links = ctx.tenants.filter(t => t.slug === route.slug && t.tenant_status === 'active');
    const link = links.find(t => t.role === 'admin') || links.find(t => t.role === 'porteiro') || links[0];
    if (!link) return <Alert tone="danger">Sem vínculo ativo neste condomínio. <a href="/app" onClick={onLink}>Escolher outro</a></Alert>;
    if (!route.area) return <Redirect to={`/c/${route.slug}/${link.role === 'morador' ? 'morador' : 'portaria'}`} />;
    const admin = link.role === 'admin';
    const staff = admin || link.role === 'porteiro';
    const perm = (p: string) => admin && link.permissions.includes(p);
    let page: React.ReactNode = <Alert tone="danger">Área indisponível para seu vínculo.</Alert>;
    if (route.area === 'portaria' && staff) page = <Portaria />;
    if (route.area === 'painel' && admin) page = <Painel />;
    if (route.area === 'pessoas' && admin) page = <Pessoas />;
    if (route.area === 'configuracoes' && perm('settings')) page = <Config />;
    if (route.area === 'assinatura' && perm('billing')) page = <Assinatura />;
    if (route.area === 'morador' && links.some(t => t.role === 'morador')) page = <Morador />;
    if (route.area === 'avisos' && links.some(t => t.role === 'morador')) page = <Avisos />;
    if (route.area === 'ajuda') page = <Ajuda />;
    return <TenantProvider key={link.tenant_id} link={link}><TenantShell area={route.area}><Suspense fallback={<Spinner />}>{page}</Suspense></TenantShell></TenantProvider>;
  }
  return <main className="p-6"><h1>Página não encontrada</h1><a href="/app" onClick={onLink}>Voltar ao sistema</a></main>;
}

function LegalPage({ privacy }: { privacy: boolean }) {
  return <main className="max-w-2xl mx-auto px-4 py-10 space-y-4"><PortariaPrimeLogo />
    <h1 className="text-2xl font-semibold">{privacy ? 'Política de privacidade' : 'Termos de uso'}</h1>
    <Alert tone="warning">Minuta para revisão jurídica. Identificação do controlador, contato de privacidade, retenção e condições contratuais precisam ser aprovados antes da operação comercial.</Alert>
    <p>{privacy ? 'O sistema trata identificação e contatos dos usuários, vínculos com unidades, registros de encomendas, fotos e assinaturas de retirada para operar a portaria. O acesso deve ser restrito às pessoas autorizadas pelo condomínio.' : 'O acesso depende de conta verificada e vínculo autorizado com o condomínio. A equipe deve conferir destinatário, unidade e identidade de quem retira. OCR é uma sugestão que exige revisão humana.'}</p>
    <p>O teste dura um mês de calendário por condomínio. Ao final, a renovação exige pagamento por link, sem débito automático. Inadimplência não autoriza apagar histórico nem provas de retirada.</p>
    <p>Assinatura desenhada na tela é registro operacional, não assinatura digital certificada. Canais externos e conectividade podem ficar indisponíveis.</p>
    <a href="/entrar" onClick={onLink} className="underline">Voltar</a>
  </main>;
}

export default function App() {
  return <SessionProvider><Suspense fallback={<Spinner />}><Routes /></Suspense><Toaster /></SessionProvider>;
}
