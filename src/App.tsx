import React, { lazy, Suspense, useEffect } from 'react';
import { configError } from './lib/supabase';
import { SessionProvider, useSession } from './lib/session';
import { TenantProvider } from './lib/tenant';
import { matchTenant, navigate, onLink, query, usePath } from './lib/router';
import { Alert, Button, Card, Spinner, Toaster } from './components/ui';
import { PortariaPrimeLogo } from './components/Brand';
import { TourProvider } from './components/TourGuide';

// Telas de login/app carregam sob demanda: a landing pública não paga por elas.
const auth = () => import('./pages/auth/AuthPages');
const LoginPage = lazy(() => auth().then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => auth().then(m => ({ default: m.SignupPage })));
const RecoverPage = lazy(() => auth().then(m => ({ default: m.RecoverPage })));
const NewPasswordPage = lazy(() => auth().then(m => ({ default: m.NewPasswordPage })));
const InvitePage = lazy(() => auth().then(m => ({ default: m.InvitePage })));
const resident = () => import('./pages/resident/ResidentPages');
const ResidentShell = lazy(() => import('./pages/resident/ResidentShell').then(m => ({ default: m.ResidentShell })));
const RInicio = lazy(() => resident().then(m => ({ default: m.InicioPage })));
const RHistorico = lazy(() => resident().then(m => ({ default: m.HistoricoPage })));
const RNotificacoes = lazy(() => resident().then(m => ({ default: m.NotificacoesPage })));
const REncomenda = lazy(() => resident().then(m => ({ default: m.EncomendaPage })));
const RComprovante = lazy(() => resident().then(m => ({ default: m.ComprovanteRedirect })));
const RConta = lazy(() => import('./pages/resident/ContaPage').then(m => ({ default: m.ContaPage })));
const TenantShell = lazy(() => import('./pages/tenant/TenantShell').then(m => ({ default: m.TenantShell })));

const Onboarding = lazy(() => import('./pages/Onboarding').then(m => ({ default: m.OnboardingPage })));
const Portaria = lazy(() => import('./pages/tenant/portaria/PortariaPage').then(m => ({ default: m.PortariaPage })));
const AppInfo = lazy(() => import('./pages/tenant/AppPage').then(m => ({ default: m.AppPage })));
const Comprovante = lazy(() => import('./pages/tenant/Receipt').then(m => ({ default: m.ReceiptPage })));
const Avisos = lazy(() => import('./pages/tenant/MoradorPage').then(m => ({ default: m.AvisosPage })));
const Painel = lazy(() => import('./pages/tenant/PainelPage').then(m => ({ default: m.PainelPage })));
const Relatorios = lazy(() => import('./pages/tenant/PainelPage').then(m => ({ default: m.RelatoriosPage })));
const Pessoas = lazy(() => import('./pages/tenant/PessoasPage').then(m => ({ default: m.PessoasPage })));
const Config = lazy(() => import('./pages/tenant/ConfigPage').then(m => ({ default: m.ConfigPage })));
const Retorno = lazy(() => import('./pages/tenant/AssinaturaPage').then(m => ({ default: m.CheckoutReturnPage })));
const Totem = lazy(() => import('./pages/TotemPage'));
const Admin = lazy(() => import('./pages/AdminPage'));
const Ajuda = lazy(() => import('./pages/HelpPage'));
const Landing = lazy(() => import('./pages/LandingPage'));
const Tutorials = lazy(() => import('./pages/TutorialsPage'));
const Proposal = lazy(() => import('./pages/ProposalPage'));
const Org = lazy(() => import('./pages/OrgPage'));
const Support = lazy(() => import('./pages/tenant/SupportPage').then(m => ({ default: m.SupportPage })));
const legal = () => import('./pages/LegalPages');
const Contrato = lazy(() => legal().then(m => ({ default: m.ContratoPage })));
const Termos = lazy(() => legal().then(m => ({ default: m.TermosPage })));
const Privacidade = lazy(() => legal().then(m => ({ default: m.PrivacidadePage })));
const Contratar = lazy(() => import('./pages/ContratarPage'));
const Validar = lazy(() => import('./pages/ValidarPage'));
const Planos = lazy(() => import('./pages/PlanosPage'));
const Portal = lazy(() => import('./pages/PortalPage').then(m => ({ default: m.PortalPage })));
const RequestAccess = lazy(() => import('./pages/PortalPage').then(m => ({ default: m.RequestAccessPage })));

const RESIDENT_AREAS = new Set(['inicio', 'historico', 'notificacoes', 'conta', 'encomenda', 'comprovante', 'morador', 'avisos']);

function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, true); }, [to]);
  return <Spinner />;
}

function Routes() {
  const path = usePath();
  const { ctx, session, loading, error, refresh, signOut } = useSession();
  const route = matchTenant(path);
  if (path === '/contrato') return <Contrato />;
  if (path === '/termos') return <Termos />;
  if (path === '/privacidade') return <Privacidade />;
  if (path === '/tutoriais' || /^\/tutoriais\/(sindico|portaria|morador)$/.test(path)) return <Tutorials profile={path.split('/')[2] || null} />;
  if (path === '/proposta') return <Proposal />;
  if (path === '/validar') return <Validar />;
  if (path === '/planos') return <Planos />;
  if (configError) return <main className="max-w-lg mx-auto p-6"><PortariaPrimeLogo /><Alert tone="danger">{configError}</Alert></main>;
  // /totem: equipe logada vai ao totem da equipe (OCR, entrega); sem login segue o totem público pareado.
  if (route?.area === 'totem') {
    if (loading) return <Spinner />;
    const staffHere = ctx?.tenants.some(t => t.slug === route.slug && t.tenant_status === 'active' && (t.role === 'admin' || t.role === 'porteiro'));
    return staffHere ? <Redirect to={`/c/${route.slug}/totem-equipe`} /> : <Totem slug={route.slug} />;
  }
  // Landing pública: não espera a sessão; com sessão mostra "Acessar meu condomínio".
  if (path === '/') return <Landing />;
  if (loading) return <Spinner />;
  if (path === '/entrar') return <LoginPage />;
  if (path === '/cadastro') return <SignupPage />;
  if (path === '/recuperar-senha') return <RecoverPage />;
  if (path === '/nova-senha') return <NewPasswordPage />;
  if (path === '/convite') return <InvitePage />;
  if (path === '/org/convite') return <Org />;
  // Portal do condomínio: página pública com a marca dele (sem sessão não há dados internos).
  // Sem sessão: link profundo do morador (aviso/e-mail/WhatsApp) vai ao login com a marca do portal e volta ao destino.
  if (route && !session) return route.area && RESIDENT_AREAS.has(route.area)
    ? <Redirect to={`/entrar?next=${encodeURIComponent(location.pathname + location.search)}&portal=${route.slug}`} />
    : route.area ? <Redirect to={`/c/${route.slug}`} /> : <Portal slug={route.slug} />;
  if (route?.area === 'solicitar') return <RequestAccess slug={route.slug} />;
  if (!session) return <Redirect to={`/entrar?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  if (error || !ctx) return <main className="max-w-lg mx-auto p-6 space-y-4"><Alert tone="danger">{error || 'Não foi possível carregar seus vínculos.'}</Alert><Button onClick={refresh}>Tentar novamente</Button><Button variant="ghost" onClick={signOut}>Sair</Button></main>;
  if (path === '/contratar') return <Contratar />;
  if (path === '/org' || path.startsWith('/org/')) return <Org />;
  if (path === '/onboarding') return <Onboarding />;
  if (path === '/checkout/retorno') return <Retorno />;
  if (path === '/admin') return (ctx.platform_admin || ctx.platform_role) ? <Admin /> : <Alert tone="danger">Acesso restrito à administração da plataforma.</Alert>;
  if (path === '/app') return <main className="max-w-2xl mx-auto px-4 py-10 space-y-5">
    <PortariaPrimeLogo /><h1 className="text-2xl font-semibold">Escolha o condomínio</h1>
    {ctx.tenants.length === 0 && <Alert>Nenhum vínculo ativo. Use o convite recebido ou cadastre seu condomínio.</Alert>}
    {Array.from(new Map(ctx.tenants.map(t => [t.tenant_id, t])).values()).map(t => <Card key={t.tenant_id}>
      <a className="font-semibold underline" href={`/c/${t.slug}`} onClick={onLink}>{t.name}</a>
    </Card>)}
    <Button onClick={() => navigate(ctx.tenants.length ? '/onboarding?novo=1' : '/onboarding')}>Cadastrar condomínio</Button>
    <Button variant="secondary" onClick={() => navigate('/org')}>Administradoras</Button>
    {(ctx.platform_admin || ctx.platform_role) && <Button variant="secondary" onClick={() => navigate('/admin')}>Administrar plataforma</Button>}
    <Button variant="ghost" onClick={signOut}>Sair</Button>
  </main>;
  if (route) {
    const links = ctx.tenants.filter(t => t.slug === route.slug && t.tenant_status === 'active');
    const link = links.find(t => t.role === 'admin') || links.find(t => t.role === 'porteiro') || links[0];
    // Logado sem vínculo aqui: portal (pedir cadastro), nunca dados deste condomínio.
    // Áreas do morador sem vínculo ativo: situação do cadastro (pendente, recusado, encerrado) ou pedido.
    if (!link) return RESIDENT_AREAS.has(route.area || '') ? <RequestAccess slug={route.slug} /> : <Portal slug={route.slug} />;
    if (!route.area) return <Redirect to={`/c/${route.slug}/${link.role === 'morador' ? 'inicio' : link.role === 'admin' ? 'painel' : 'portaria'}`} />;
    // App do morador: navegação própria; rotas antigas (inclusive links de avisos já enviados) redirecionam.
    if (link.role === 'morador') {
      const old: Record<string, string> = { morador: 'inicio', avisos: 'notificacoes', aplicativo: 'conta#notificacoes', painel: 'inicio', portaria: 'inicio' };
      if (old[route.area]) return <Redirect to={`/c/${route.slug}/${old[route.area]}`} />;
      const pages: Record<string, React.ReactNode> = {
        inicio: <RInicio />, historico: <RHistorico />, notificacoes: <RNotificacoes />, conta: <RConta />,
        encomenda: <REncomenda />, comprovante: <RComprovante />, ajuda: <Ajuda />,
      };
      const rpage = pages[route.area] || <Alert tone="warning">Esta área não faz parte do app do morador. <a className="underline" href={`/c/${route.slug}/inicio`} onClick={onLink}>Ir para o início</a></Alert>;
      return <TenantProvider key={link.tenant_id} link={link}><TourProvider><Suspense fallback={<Spinner />}><ResidentShell area={route.area}><Suspense fallback={<Spinner />}>{rpage}</Suspense></ResidentShell></Suspense></TourProvider></TenantProvider>;
    }
    const admin = link.role === 'admin';
    const staff = admin || link.role === 'porteiro';
    const perm = (p: string) => admin && link.permissions.includes(p);
    let page: React.ReactNode = <Alert tone="danger">Área indisponível para seu vínculo.</Alert>;
    if (route.area === 'suporte' && staff) page = <Support />;
    if (route.area === 'portaria' && staff) page = <Portaria />;
    if (route.area === 'totem-equipe' && staff) page = <Portaria totem />;
    if (route.area === 'painel' && admin) page = <Painel />;
    if (route.area === 'relatorios' && admin) page = <Relatorios />;
    if (route.area === 'pessoas' && admin) page = <Pessoas tab={query('aba')} />;
    // Cada módulo valida a própria permissão (settings/team/billing).
    if (route.area === 'configuracoes' && (perm('settings') || perm('team') || perm('billing'))) page = <Config section={query('m')} />;
    if (route.area === 'assinatura') return <Redirect to={`/c/${route.slug}/configuracoes?m=plano`} />;
    if (route.area === 'avisos') page = <Avisos />;
    if (route.area === 'aplicativo') page = <AppInfo />;
    if (route.area === 'ajuda') page = <Ajuda />;
    if (route.area === 'comprovante') page = <Comprovante />;
    return <TenantProvider key={link.tenant_id} link={link}><TourProvider><TenantShell area={route.area}><Suspense fallback={<Spinner />}>{page}</Suspense></TenantShell></TourProvider></TenantProvider>;
  }
  return <main className="p-6"><h1>Página não encontrada</h1><a href="/app" onClick={onLink}>Voltar ao sistema</a></main>;
}

export default function App() {
  return <SessionProvider><Suspense fallback={<Spinner />}><Routes /></Suspense><Toaster /></SessionProvider>;
}
