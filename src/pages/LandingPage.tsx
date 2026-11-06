import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, ClipboardCheck, FileCheck2, History, LayoutDashboard, ListChecks, MapPin, Menu, PackageSearch, ScanLine, ShieldCheck, Smartphone, Target, Warehouse, X } from 'lucide-react';
import { PortariaPrimeLogo } from '../components/Brand';
import { ContactForm } from '../components/ContactForm';
import { KioskPilotForm, KioskPlanNote } from '../components/KioskPilotForm';
import { KIOSK } from '../lib/kiosk-offer';
import { QuoteForm, QUOTE_POLICY_SUMMARY } from '../components/QuoteForm';
import { Button, Card } from '../components/ui';
import { featureList, loadCatalog, loadQuotePolicy, PlanRow } from '../lib/catalog';
import { brl, CYCLE_LABEL, CYCLE_MONTHS } from '../lib/format';
import { track } from '../lib/funnel';
import { navigate, onLink } from '../lib/router';
import { useSession } from '../lib/session';
import { Screen, ScreenKey, SCREENS, srcSet } from '../lib/screens';
import { PROFILES, TUTORIALS } from '../lib/tutorials';

type Cycle = 'monthly' | 'quarterly' | 'yearly';
type Policy = Awaited<ReturnType<typeof loadQuotePolicy>>;

/** Seis momentos da encomenda: o que acontece e quem é afetado em seguida. */
const FLOW: { icon: React.ElementType; title: string; text: string; next: string; screen: ScreenKey }[] = [
  { icon: ScanLine, title: 'Ler e conferir', text: 'A leitura da etiqueta sugere destinatário, unidade e rastreio. A portaria confere antes de salvar.', next: 'Portaria: dados corretos antes do registro.', screen: 'recebimento' },
  { icon: Warehouse, title: 'Guardar', text: 'O sistema sugere o local com espaço e registra onde a encomenda ficou. Local lotado não é escolhido sozinho.', next: 'Síndico: ocupação visível no painel.', screen: 'armazenamento' },
  { icon: Bell, title: 'Avisar', text: 'O aviso sai de uma fila no servidor para todos os moradores autorizados da unidade, com novas tentativas em caso de falha.', next: 'Morador: encomenda aparece no Início.', screen: 'morador' },
  { icon: PackageSearch, title: 'Localizar', text: 'Na retirada, o QR do morador localiza a encomenda e mostra onde ela está guardada.', next: 'Portaria: busca por unidade, rastreio ou nome.', screen: 'portariaMobile' },
  { icon: ClipboardCheck, title: 'Entregar', text: 'Assinatura e foto do item. A confirmação é única: a mesma encomenda não é entregue duas vezes.', next: 'Morador: retirada registrada no histórico.', screen: 'portariaMobile' },
  { icon: FileCheck2, title: 'Comprovar', text: 'Comprovante em PDF com a identidade do condomínio, protocolo e quem retirou, enviado à unidade.', next: 'Todos: prova consultável depois.', screen: 'comprovante' },
];

const DEMO: Record<'sindico' | 'portaria' | 'morador', { benefit: string; screen: ScreenKey; tasks: string[] }> = {
  sindico: { benefit: 'Visão da operação com números calculados no servidor.', screen: 'painel', tasks: ['Aprovar moradores pelo portal do condomínio', 'Ver o que aguarda retirada e o que passou do prazo', 'Configurar marca, locais e canais de aviso'] },
  portaria: { benefit: 'Receber e entregar com menos digitação e prova registrada.', screen: 'recebimento', tasks: ['Fotografar a etiqueta e conferir a leitura', 'Guardar no local sugerido', 'Entregar com QR, assinatura e foto'] },
  morador: { benefit: 'Saber o que chegou e retirar sem fila de conferência.', screen: 'morador', tasks: ['Ver encomendas aguardando no Início', 'Mostrar o QR de retirada', 'Consultar quem retirou e o comprovante'] },
};

/** Comportamento real do app Android gerenciado (docs/KIOSK_ANDROID.md e KIOSK_QA.md). */
const KIOSK_FAQ: [string, string][] = [
  ['O que é o Modo Portaria Exclusiva?', `${KIOSK.description} O aparelho abre direto na portaria do condomínio e cada porteiro entra com a própria conta.`],
  ['Em qual plano está incluído?', `Em todos os planos. ${KIOSK.pilot}`],
  ['É obrigatório?', 'Não. O uso é opcional; o sistema continua funcionando no navegador e no app instalado.'],
  ['Preciso comprar aparelho?', 'O equipamento não está incluso. É preciso um Android compatível, do condomínio e dedicado à portaria. Antes de comprar, solicite a ativação piloto para conferirmos o modelo.'],
  ['Funciona em qualquer Android?', 'Não. O app exige Android 8.0 ou superior e o comportamento varia por fabricante. A liberação depende da validação de compatibilidade do modelo.'],
  ['Funciona em iPhone ou iPad?', 'Não. O Modo Portaria Exclusiva é só para Android compatível. No iPhone e no iPad, use o sistema pelo navegador ou pelo app instalado.'],
  ['Qual a diferença para o app instalado (PWA)?', KIOSK.pwa],
  ['Como solicito?', 'Preencha o formulário desta seção com o condomínio, a marca, o modelo e a versão do Android. Você recebe um protocolo e a resposta da equipe por e-mail.'],
  ['O síndico pode liberar o aparelho para manutenção?', 'Sim. Pelo painel, abre uma manutenção com prazo, que termina sozinha. Sem internet no aparelho, usa um código de recuperação de uso único gerado pelo síndico; tentativas erradas seguidas bloqueiam por alguns minutos.'],
  ['E depois de reiniciar?', 'O aparelho volta sozinho ao Portaria Prime. Isso foi validado em emulador; a homologação em aparelho físico ainda está pendente.'],
  ['O que funciona sem internet?', 'O aparelho continua travado com a última configuração recebida. Recebimentos, entregas e comprovantes só são confirmados com conexão com o servidor.'],
  ['Pode exigir formatação?', 'Pode. O método oficial de configuração (QR na tela inicial do Android) exige restauração de fábrica, que apaga os dados do aparelho. Em alguns aparelhos sem contas é possível uma configuração técnica por cabo sem restauração, mas isso depende do fabricante e é avaliado caso a caso.'],
  ['Como retiro o gerenciamento?', 'Pelo painel do síndico, em “Desativar gerenciamento”. O aparelho precisa estar on-line para confirmar. Em alguns modelos, voltar ao uso comum pode exigir restauração de fábrica.'],
];

function Shot({ s, onZoom, eager, sizes = '(min-width: 1024px) 560px, 100vw', className = '' }: { s: Screen; onZoom: (s: Screen) => void; eager?: boolean; sizes?: string; className?: string }) {
  return (
    <button type="button" className={`block w-full text-left group ${className}`} onClick={() => onZoom(s)}>
      <img src={s.file} srcSet={srcSet(s)} sizes={sizes} alt={`${s.title}: ${s.caption}`} width={s.width} height={s.height}
        loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : undefined}
        className={`w-full rounded-xl border border-line bg-surface ${s.width < 600 ? 'max-h-[560px] object-contain' : 'h-auto'} group-hover:opacity-95`} />
      <span className="sr-only">Ampliar {s.title}</span>
    </button>
  );
}

/** Página pública. Preços, limites e política de proposta vêm do servidor. Sem depoimentos, contagens ou métricas não medidas. */
export default function LandingPage() {
  const { session } = useSession();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [menu, setMenu] = useState(false);
  const [zoom, setZoom] = useState<Screen | null>(null);
  const [step, setStep] = useState(0);
  // Vídeo demonstrativo no formato da tela: vertical (9:16) no celular, horizontal (16:9) no resto.
  const [demo, setDemo] = useState<'16x9' | '9x16'>(() => (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 639px)').matches ? '9x16' : '16x9'));
  useEffect(() => {
    const mq = matchMedia('(max-width: 639px)');
    const on = () => setDemo(mq.matches ? '9x16' : '16x9');
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  const [profile, setProfile] = useState<keyof typeof DEMO>('sindico');
  const pricingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    track('landing_view');
    loadCatalog().then(setPlans).catch(() => setCatalogError(true));
    loadQuotePolicy().then(setPolicy).catch(() => setPolicy(null));
  }, []);
  useEffect(() => {
    const el = pricingRef.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { track('pricing_view'); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!zoom) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(null);
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [zoom]);

  const trial = (plan?: string) => {
    track('cta_trial_click', plan);
    const q = plan ? `?plano=${plan}&ciclo=${cycle}` : '';
    navigate(session ? `/onboarding${q}` : `/cadastro?next=${encodeURIComponent(`/onboarding${q}`)}`);
  };
  const selectable = (plans || []).filter((p) => p.published && !p.is_custom && p.prices.length);
  const custom = (plans || []).find((p) => p.is_custom);
  const nav: [string, string][] = [['#como-funciona', 'Como funciona'], ['#demonstracao', 'Vídeo'], ['/demonstracao', 'Ver demonstração'], ['#portaria-exclusiva', 'Portaria Exclusiva'], ['/tutoriais', 'Tutoriais'], ['/planos', 'Planos e contrato']];
  // /demonstracao precisa de carga completa da página (o modo demonstração é decidido antes do cliente existir).
  const navLink = ([h, l]: [string, string], extra = '') => h.startsWith('/') && h !== '/demonstracao'
    ? <a key={h} href={h} onClick={(e) => { onLink(e); setMenu(false); }} className={extra}>{l}</a>
    : <a key={h} href={h} onClick={() => setMenu(false)} className={extra}>{l}</a>;
  const f = FLOW[step];
  const d = DEMO[profile];

  return (
    <div className="min-h-dvh bg-bg text-text">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 bg-surface px-3 py-2 rounded-lg z-50">Pular para o conteúdo</a>
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <a href="/" aria-label="Portaria Prime, início"><PortariaPrimeLogo className="h-8 w-auto" /></a>
          <nav aria-label="Seções" className="hidden lg:flex items-center gap-6 text-sm font-medium">{nav.map((n) => navLink(n, 'hover:text-secondary'))}</nav>
          <div className="hidden lg:flex items-center gap-2">
            {session ? <Button variant="secondary" onClick={() => navigate('/app')}>Acessar meu condomínio</Button> : <a href="/entrar" onClick={onLink} className="px-3 min-h-11 inline-flex items-center text-sm font-semibold">Entrar</a>}
            <Button onClick={() => trial()}>Testar grátis por 1 mês</Button>
          </div>
          <button className="lg:hidden p-2 min-h-11 min-w-11 grid place-items-center" aria-label={menu ? 'Fechar menu' : 'Abrir menu'} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</button>
        </div>
        {menu && <nav aria-label="Seções" className="lg:hidden border-t border-line px-4 py-3 space-y-1 bg-surface">
          {nav.map((n) => navLink(n, 'block min-h-11 py-2'))}
          {session ? <a href="/app" onClick={onLink} className="block min-h-11 py-2 font-semibold">Acessar meu condomínio</a> : <a href="/entrar" onClick={onLink} className="block min-h-11 py-2 font-semibold">Entrar</a>}
          <Button className="w-full" onClick={() => trial()}>Testar grátis por 1 mês</Button>
        </nav>}
      </header>

      <main id="conteudo">
        {/* Hero */}
        <section className="bg-midnight text-porcelain">
          <div className="max-w-6xl mx-auto px-4 py-14 lg:py-20 grid lg:grid-cols-[1fr_1.15fr] gap-10 items-center">
            <div>
              <h1 className="text-4xl sm:text-5xl font-semibold leading-tight">Cada encomenda. Tudo sob controle.</h1>
              <p className="mt-3 text-xl text-champagne">Da chegada à retirada, sua portaria no controle.</p>
              <p className="mt-4 text-lg text-porcelain/80 max-w-xl">Registre o que chegou, avise todos os moradores da unidade automaticamente e documente cada retirada com assinatura, foto e comprovante.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <button onClick={() => trial()} className="min-h-12 px-6 rounded-xl bg-champagne text-midnight font-semibold hover:opacity-90">Testar grátis por 1 mês</button>
                <a href="/demonstracao" className="min-h-12 px-6 rounded-xl border border-porcelain/40 inline-flex items-center font-semibold hover:bg-white/10">Ver demonstração</a>
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-porcelain/80">
                {['Um mês de calendário grátis, sem cartão', 'Pagamento por link, sem débito automático', 'Funciona no navegador; instale se quiser'].map((t) =>
                  <li key={t} className="flex gap-2 items-center"><Check className="w-4 h-4 text-champagne" aria-hidden />{t}</li>)}
              </ul>
            </div>
            <figure className="relative">
              <Shot s={SCREENS.painel} onZoom={setZoom} eager />
              <div className="hidden sm:block absolute -bottom-8 -left-6 w-[30%] min-w-36 rounded-2xl shadow-2xl ring-4 ring-midnight overflow-hidden">
                <Shot s={SCREENS.morador} onZoom={setZoom} sizes="200px" />
              </div>
              <figcaption className="mt-2 sm:mt-10 text-xs text-porcelain/60">Telas reais com dados de demonstração. Toque para ampliar.</figcaption>
            </figure>
          </div>
        </section>

        {/* Vídeo demonstrativo: horizontal no computador, vertical no celular. Só carrega ao tocar (preload="none"). */}
        <section id="video" className="max-w-6xl mx-auto px-4 pt-16" aria-labelledby="video-h">
          <h2 id="video-h" className="text-3xl font-semibold">Veja o Portaria Prime em 1 minuto</h2>
          <p className="text-muted mt-2">Da chegada da encomenda ao comprovante de retirada, com as telas reais do sistema.</p>
          <div className="mt-6 rounded-2xl overflow-hidden border border-line bg-midnight shadow-sm mx-auto max-w-sm sm:max-w-none">
            <video key={demo} className="block w-full h-auto" controls playsInline preload="none"
              poster={`/video/demonstracao-${demo}.webp`} aria-label="Vídeo demonstrativo do Portaria Prime"
              style={{ aspectRatio: demo === '16x9' ? '16 / 9' : '9 / 16' }}>
              <source src={`/video/demonstracao-${demo}.mp4`} type="video/mp4" />
            </video>
          </div>
        </section>

        {/* Seis momentos */}
        <section id="como-funciona" className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="como-h">
          <h2 id="como-h" className="text-3xl font-semibold">Como funciona</h2>
          <p className="text-muted mt-2">Seis momentos de uma encomenda. Escolha um para ver a tela e o efeito para o próximo perfil.</p>
          <div className="mt-8 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-6 items-start">
            <ol role="tablist" aria-label="Momentos da encomenda" className="grid gap-2">
              {FLOW.map((x, i) => (
                <li key={x.title}>
                  <button role="tab" aria-selected={step === i} aria-controls="fluxo-painel" id={`fluxo-${i}`} onClick={() => setStep(i)}
                    className={`w-full text-left rounded-2xl border p-4 flex gap-3 items-start min-h-11 ${step === i ? 'border-secondary bg-surface shadow-sm' : 'border-line bg-bg hover:bg-surface'}`}>
                    <span className={`h-8 w-8 shrink-0 rounded-full grid place-items-center text-sm font-semibold ${step === i ? 'bg-secondary text-white' : 'bg-midnight text-porcelain'}`}>{i + 1}</span>
                    <span><span className="font-semibold block">{x.title}</span><span className="text-sm text-muted">{x.text}</span></span>
                  </button>
                </li>
              ))}
            </ol>
            <div id="fluxo-painel" role="tabpanel" aria-labelledby={`fluxo-${step}`} className="lg:sticky lg:top-24">
              <Shot s={SCREENS[f.screen]} onZoom={setZoom} sizes="(min-width: 1024px) 640px, 100vw" />
              <p className="mt-3 text-sm flex items-start gap-2"><f.icon className="w-4 h-4 mt-0.5 text-secondary shrink-0" aria-hidden /><span><strong>Efeito:</strong> {f.next}</span></p>
            </div>
          </div>
        </section>

        {/* Demonstração por perfil + encomenda de ponta a ponta */}
        <section id="demonstracao" className="bg-surface border-y border-line" aria-labelledby="demo-h">
          <div className="max-w-6xl mx-auto px-4 py-16">
            <h2 id="demo-h" className="text-3xl font-semibold">Demonstração por perfil</h2>
            <div role="tablist" aria-label="Perfil" className="mt-6 inline-flex rounded-xl bg-surface-2 p-1">
              {(Object.keys(DEMO) as (keyof typeof DEMO)[]).map((p) => (
                <button key={p} role="tab" aria-selected={profile === p} onClick={() => setProfile(p)}
                  className={`min-h-11 px-4 rounded-lg text-sm font-medium ${profile === p ? 'bg-surface shadow text-text' : 'text-muted'}`}>{PROFILES[p].title.split(' ')[0]}</button>
              ))}
            </div>
            <div role="tabpanel" className="mt-6 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-6 items-start">
              <div>
                <p className="text-lg font-semibold">{d.benefit}</p>
                <ol className="mt-4 space-y-2">{d.tasks.map((t, i) => <li key={t} className="flex gap-2"><span className="text-secondary font-semibold">{i + 1}.</span>{t}</li>)}</ol>
                <a href={`/tutoriais/${profile}`} onClick={onLink} className="mt-6 inline-flex min-h-11 items-center font-semibold underline">Tutorial completo para {PROFILES[profile].title.toLowerCase()}</a>
              </div>
              <Shot s={SCREENS[d.screen]} onZoom={setZoom} sizes="(min-width: 1024px) 640px, 100vw" />
            </div>

            <div className="mt-14">
              <h3 className="text-2xl font-semibold">Uma encomenda de ponta a ponta</h3>
              <p className="text-muted mt-1">Mesmo protocolo fictício, PP-DEMO-0001, do recebimento ao comprovante. Telas reais de um ambiente de demonstração isolado, sem envios externos.</p>
              <ol className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {([['recebimento', 'Portaria registra e confere a etiqueta'], ['morador', 'Morador vê a encomenda no app'], ['portariaMobile', 'Portaria localiza e entrega'], ['comprovante', 'Comprovante com assinatura e foto']] as [ScreenKey, string][]).map(([k, t], i) => (
                  <li key={k + i} className="space-y-2"><Shot s={SCREENS[k]} onZoom={setZoom} sizes="(min-width: 1024px) 280px, 50vw" /><p className="text-sm"><strong>{i + 1}.</strong> {t}</p></li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Modo Portaria Exclusiva (acesso piloto) */}
        <section id="portaria-exclusiva" className="bg-midnight text-porcelain" aria-labelledby="kiosk-h">
          <div className="max-w-6xl mx-auto px-4 py-16 grid lg:grid-cols-[1fr_1.15fr] gap-10 items-start">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-champagne/50 px-3 py-1 text-xs font-semibold text-champagne"><Smartphone className="w-4 h-4" aria-hidden />{KIOSK.name} · acesso piloto</p>
              <h2 id="kiosk-h" className="mt-4 text-3xl sm:text-4xl font-semibold leading-tight">Um dispositivo dedicado à portaria. Mais foco na operação.</h2>
              <p className="mt-3 text-lg text-porcelain/80">Organize a rotina de encomendas em um Android preparado para o Portaria Prime, com gerenciamento pelo condomínio e acesso controlado.</p>
              <ul className="mt-6 grid sm:grid-cols-2 gap-3 text-sm">
                {([
                  [Target, 'Foco da equipe', 'O aparelho abre direto na portaria do condomínio, sem outros apps no caminho.'],
                  [ListChecks, 'Terminal padronizado', 'Mesma tela de receber, entregar e buscar em todos os turnos.'],
                  [ShieldCheck, 'Dispositivos autorizados', 'Só aparelhos vinculados pelo síndico entram; cada porteiro usa a própria conta.'],
                  [PackageSearch, 'Fluxo completo', 'Leitura de etiqueta, QR, assinatura, foto do item e comprovante dentro do terminal.'],
                  [LayoutDashboard, 'Administração centralizada', 'Situação, manutenção com prazo e retirada do gerenciamento pelo painel.'],
                ] as [React.ElementType, string, string][]).map(([I, t, x]) => <li key={t} className="flex gap-3"><I className="w-5 h-5 mt-0.5 text-champagne shrink-0" aria-hidden /><span><strong className="block">{t}</strong><span className="text-porcelain/75">{x}</span></span></li>)}
              </ul>
              <ol className="mt-8 grid sm:grid-cols-3 gap-3 text-sm" aria-label="Como ativar">
                {['Verificar compatibilidade e preparar o equipamento', 'Vincular o aparelho ao condomínio', 'Ativar e gerenciar pelo painel'].map((t, i) =>
                  <li key={t} className="rounded-xl border border-porcelain/20 p-3"><span className="h-7 w-7 rounded-full bg-champagne text-midnight grid place-items-center font-semibold">{i + 1}</span><span className="block mt-2">{t}</span></li>)}
              </ol>
              <div className="mt-8 flex flex-wrap gap-3">
                <button onClick={() => trial()} className="min-h-12 px-6 rounded-xl bg-champagne text-midnight font-semibold hover:opacity-90">Começar meu mês grátis</button>
                <a href="/tutoriais/sindico#quiosque-preparar-inscrever" onClick={onLink} className="min-h-12 px-6 rounded-xl border border-porcelain/40 inline-flex items-center font-semibold hover:bg-white/10">Ver como funciona</a>
                <a href="#ativacao-piloto" className="min-h-12 px-6 rounded-xl border border-champagne inline-flex items-center font-semibold text-champagne hover:bg-white/10">{KIOSK.cta}</a>
              </div>
              <p className="mt-6 text-sm text-porcelain/80">{KIOSK.included} {KIOSK.pilot}</p>
              <p className="mt-2 text-sm text-porcelain/80"><strong>{KIOSK.requirement}</strong> A configuração inicial pode exigir restauração de fábrica, conforme o dispositivo e o método. Não funciona em iPhone ou iPad.</p>
              <p className="mt-2 text-xs text-porcelain/60">{KIOSK.pwa}</p>
            </div>
            <figure>
              <div className="rounded-[1.75rem] bg-black/60 p-3 ring-1 ring-porcelain/20 shadow-2xl"><Shot s={SCREENS.quiosqueRecebimento} onZoom={setZoom} sizes="(min-width: 1024px) 600px, 100vw" /></div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {(['quiosqueComprovante', 'quiosqueManutencao'] as const).map((k) => <div key={k} className="rounded-2xl bg-black/60 p-2 ring-1 ring-porcelain/20"><Shot s={SCREENS[k]} onZoom={setZoom} sizes="(min-width: 1024px) 300px, 50vw" /></div>)}
              </div>
              <figcaption className="mt-3 text-xs text-porcelain/60">Demonstração em emulador Android 14 com dados fictícios. Ainda sem homologação em aparelho físico; por isso o recurso está em acesso piloto. Toque para ampliar.</figcaption>
            </figure>
          </div>
        </section>

        {/* Personalização */}
        <section className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="marca-h">
          <h2 id="marca-h" className="text-3xl font-semibold">A identidade do seu condomínio</h2>
          <p className="text-muted mt-2">Logo e cores próprias no portal, no app instalado e no PDF de entrega. Cada condomínio vê só os próprios dados.</p>
          <div className="mt-8 grid sm:grid-cols-2 gap-5">
            {(['marcaA', 'marcaB'] as const).map((k) => <figure key={k}><Shot s={SCREENS[k]} onZoom={setZoom} sizes="(min-width: 640px) 50vw, 100vw" />
              <figcaption className="mt-2 text-sm"><strong>{SCREENS[k].title}.</strong> <span className="text-muted">{SCREENS[k].caption}</span></figcaption></figure>)}
          </div>
        </section>

        {/* Benefícios verificáveis */}
        <section className="bg-surface border-y border-line" aria-labelledby="ben-h">
          <div className="max-w-6xl mx-auto px-4 py-16">
            <h2 id="ben-h" className="text-3xl font-semibold">O que dá para conferir</h2>
            <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {([
                [MapPin, 'Localização física', 'Cada encomenda tem local de guarda, capacidade por local e histórico de movimentações.'],
                [Bell, 'Comunicação acompanhada', 'Cada aviso tem estado: pendente, aceito pelo provedor, falha ou canal não configurado. Falhas voltam à fila e a administração é alertada.'],
                [ShieldCheck, 'Retirada documentada', 'QR de uso único validado no servidor, assinatura, foto do item e comprovante com protocolo.'],
                [History, 'Análise de pendências', 'Aguardando agora, acima do prazo, tempo até a retirada (mediana e P90) e horários de pico.'],
              ] as [React.ElementType, string, string][]).map(([I, t, x]) => <Card key={t}><I className="w-6 h-6 text-secondary" aria-hidden /><h3 className="font-semibold mt-3">{t}</h3><p className="text-sm text-muted mt-1">{x}</p></Card>)}
            </div>
            <p className="mt-4 text-xs text-muted">Assinatura desenhada na tela é registro operacional, não certificado digital. Entrega de e-mail, WhatsApp e notificação depende do aparelho e do provedor.</p>
          </div>
        </section>

        {/* Tutoriais */}
        <section className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="tut-h">
          <h2 id="tut-h" className="text-3xl font-semibold">Tutoriais por perfil</h2>
          <p className="text-muted mt-2">Passo a passo completo, com telas reais, antes mesmo de criar a conta.</p>
          <div className="mt-8 grid md:grid-cols-3 gap-4">
            {(Object.keys(PROFILES) as (keyof typeof PROFILES)[]).map((p) => (
              <Card key={p} className="flex flex-col">
                <h3 className="text-lg font-semibold">{PROFILES[p].title}</h3>
                <ul className="mt-3 space-y-1 text-sm flex-1">{TUTORIALS.filter((t) => t.profile === p).slice(0, 4).map((t) =>
                  <li key={t.slug}><a href={`/tutoriais/${p}#${t.slug}`} onClick={onLink} className="underline-offset-2 hover:underline">{t.title}</a></li>)}</ul>
                <a href={`/tutoriais/${p}`} onClick={onLink} className="mt-4 font-semibold underline min-h-11 inline-flex items-center">Ver todos</a>
              </Card>
            ))}
          </div>
        </section>

        {/* Planos */}
        <section id="planos" ref={pricingRef} className="bg-surface border-y border-line" aria-labelledby="planos-h">
          <div className="max-w-6xl mx-auto px-4 py-16">
            <h2 id="planos-h" className="text-3xl font-semibold">Planos</h2>
            <p className="text-muted mt-2">Todo condomínio novo começa com um mês de calendário grátis, sem cartão. Depois, o pagamento é por link a cada ciclo (Pix ou cartão), sem débito automático.</p>
            <div className="mt-6 inline-grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Ciclo de pagamento">
              {(['monthly', 'quarterly', 'yearly'] as const).map((c) => <button key={c} role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)} className={`min-h-11 px-4 rounded-lg text-sm font-medium ${cycle === c ? 'bg-surface shadow text-text' : 'text-muted'}`}>{CYCLE_LABEL[c]}{(() => { const ref = selectable[0]; const m = ref?.prices.find((x) => x.cycle === 'monthly')?.amount_cents; const t = ref?.prices.find((x) => x.cycle === c)?.amount_cents;
                const pct = c !== 'monthly' && m && t ? Math.round((1 - t / (m * CYCLE_MONTHS[c])) * 100) : 0; return pct > 0 && <span className="ml-1 text-success text-xs font-semibold">−{pct}%</span>; })()}</button>)}
            </div>
            {catalogError ? <p className="mt-6 text-sm">Não foi possível carregar os planos agora. Recarregue a página ou fale com a gente pelo formulário abaixo.</p>
              : !plans ? <p className="mt-6 text-sm text-muted" role="status">Carregando planos…</p>
              : selectable.length === 0 ? <p className="mt-6 text-sm">Os planos estão em revisão e serão publicados em breve. Deixe seu contato abaixo para receber os valores.</p>
              : (
              <div className="mt-8 grid md:grid-cols-3 gap-4">
                {selectable.map((p) => {
                  const pr = p.prices.find((x) => x.cycle === cycle);
                  return (
                    <Card key={p.code} className={`flex flex-col ${p.code === 'profissional' ? 'ring-2 ring-secondary' : ''}`}>
                      <h3 className="text-xl font-semibold">{p.name}</h3>
                      {p.description && <p className="text-sm text-muted mt-1">{p.description}</p>}
                      {pr ? <p className="mt-4"><span className="text-3xl font-semibold">{brl(pr.amount_cents)}</span> <span className="text-sm text-muted">{cycle === 'monthly' ? 'por mês' : `cobrado a cada ciclo ${CYCLE_LABEL[cycle].toLowerCase()}`}</span></p> : <p className="mt-4 text-sm text-muted">Ciclo indisponível neste plano.</p>}
                      {pr && cycle !== 'monthly' && (() => { const m = p.prices.find((x) => x.cycle === 'monthly')?.amount_cents; const pct = m ? Math.round((1 - pr.amount_cents / (m * CYCLE_MONTHS[cycle])) * 100) : 0;
                        return <p className="text-xs text-muted">equivale a {brl(Math.round(pr.amount_cents / CYCLE_MONTHS[cycle]))}/mês{pct > 0 && <strong className="text-success"> · {pct}% de desconto</strong>}; o valor total é cobrado de uma vez no início do ciclo</p>; })()}
                      <p className="text-xs text-muted mt-1">Valor após o mês grátis.</p>
                      <ul className="mt-4 space-y-2 text-sm flex-1">{featureList(p).map((x) => <li key={x} className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-success shrink-0" aria-hidden />{x}</li>)}</ul>
                      <KioskPlanNote className="mt-3" />
                      <Button className="mt-6 w-full" onClick={() => trial(p.code)} disabled={!pr}>Testar grátis por 1 mês</Button>
                      <a href={`/planos?plano=${p.code}&ciclo=${cycle}`} onClick={onLink} className="mt-2 text-center text-sm font-semibold underline min-h-11 inline-flex items-center justify-center">Ver contrato e contratar</a>
                    </Card>
                  );
                })}
              </div>
            )}
            <p className="mt-6 text-sm">Quer ver antes de contratar? <a href="/demonstracao" className="font-semibold underline">Ver demonstração</a> com dados fictícios, sem cadastro.</p>
            <p className="mt-2 text-sm"><strong>{KIOSK.name}:</strong> {KIOSK.included} {KIOSK.pilot} <a href="#ativacao-piloto" className="underline">{KIOSK.cta}</a>.</p>
            {custom && <p className="mt-2 text-sm"><strong>{custom.name}:</strong> {custom.description} <a href="#contato" className="underline">Fale com a gente</a>.</p>}
            <p className="mt-2 text-sm"><strong>Administradoras:</strong> carteira de condomínios com acesso consolidado e vínculo aprovado por cada síndico. Valor sob proposta, conforme número de condomínios, unidades e consumo. <a href="#proposta" className="underline">Pedir proposta</a>.</p>
            <p className="mt-4 text-xs text-muted">Franquias de leitura de etiqueta e WhatsApp são mensais e contam mensagens aceitas pelo provedor por destinatário; falhas e repetições não contam. Ao esgotar, a digitação manual e os avisos no app continuam; nada é cobrado a mais sem contratação. Contrato, termos e privacidade: <a href="/contrato" onClick={onLink} className="underline">contrato</a>, <a href="/termos" onClick={onLink} className="underline">termos</a>, <a href="/privacidade" onClick={onLink} className="underline">privacidade</a>.</p>
          </div>
        </section>

        {/* Migração */}
        <section className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="mig-h">
          <h2 id="mig-h" className="text-3xl font-semibold">Vindo de outro sistema ou da planilha</h2>
          <div className="mt-6 grid md:grid-cols-3 gap-4">
            <Card><h3 className="font-semibold">Unidades por planilha</h3><p className="text-sm text-muted mt-1">Importação CSV com prévia antes de confirmar; repetidas são ignoradas.</p></Card>
            <Card><h3 className="font-semibold">Moradores pelo portal</h3><p className="text-sm text-muted mt-1">Cada morador pede acesso pelo link do condomínio e a administração aprova. Ninguém recebe senha por mensagem.</p></Card>
            <Card><h3 className="font-semibold">Ajuda na importação</h3><p className="text-sm text-muted mt-1">Orientamos o formato da planilha. Não pedimos senhas de outros sistemas.</p></Card>
          </div>
        </section>

        {/* Proposta competitiva */}
        <section id="proposta" className="bg-surface border-y border-line" aria-labelledby="prop-h">
          <div className="max-w-6xl mx-auto px-4 py-16 grid lg:grid-cols-[1fr_1.2fr] gap-10">
            <div>
              <h2 id="prop-h" className="text-3xl font-semibold">Receba uma proposta competitiva</h2>
              <p className="text-muted mt-3">{QUOTE_POLICY_SUMMARY}</p>
              {policy?.campaign_active && policy.criteria_text
                ? <div className="mt-4 rounded-xl bg-surface-2 p-4 text-sm"><p className="font-semibold">Condições da campanha</p><p className="mt-1 whitespace-pre-line">{policy.criteria_text}</p></div>
                : <p className="mt-4 text-sm">Cada caso é analisado por uma pessoa: comparamos escopo equivalente (unidades, portarias, canais e franquias), custo total e validade. Proposta em análise não é desconto aprovado.</p>}
              <ol className="mt-6 space-y-2 text-sm">
                {['Envie o orçamento que você recebeu (anexo opcional, sem dados pessoais desnecessários).', 'Recebemos com protocolo e analisamos.', 'Se houver condição viável, enviamos uma proposta formal com validade, limites e condições.', 'Aceitando, você segue para o contrato com os mesmos valores.'].map((t, i) =>
                  <li key={t} className="flex gap-2"><span className="font-semibold text-secondary">{i + 1}.</span>{t}</li>)}
              </ol>
            </div>
            <Card><h3 className="font-semibold mb-3">Tenho um orçamento para comparar</h3><QuoteForm policyHref="/privacidade" /></Card>
          </div>
        </section>

        {/* FAQ */}
        <section id="duvidas" className="max-w-3xl mx-auto px-4 py-16" aria-labelledby="faq-h">
          <h2 id="faq-h" className="text-3xl font-semibold">Dúvidas frequentes</h2>
          <div className="mt-6 space-y-2">
            {[
              ['Como funciona o mês grátis?', 'O teste começa ao cadastrar o condomínio e vai até o mesmo dia do mês seguinte (ou o último dia do mês, quando esse dia não existir). Não pedimos cartão. É um teste por condomínio.'],
              ['Como é a cobrança depois? Posso cancelar?', 'No fim do teste é gerado um link de pagamento da InfinitePay (Pix ou cartão) para o ciclo escolhido. Não há débito automático. Cancelar interrompe as próximas cobranças e mantém o acesso até o fim do período pago; os comprovantes não são apagados.'],
              ['Preciso comprar equipamento?', 'Não. O sistema funciona no navegador de celular, tablet ou computador. Leitor de código de barras USB e câmera são opcionais. O Modo Portaria Exclusiva, opcional, usa um Android compatível do próprio condomínio: equipamento não incluso.'],
              ['É aplicativo de loja?', 'Não está na App Store nem na Play Store. É um aplicativo web que pode ser instalado na tela inicial, com a marca do condomínio, conforme o navegador. O app Android do Modo Portaria Exclusiva é instalado na configuração inicial do aparelho, pelo QR gerado no painel.'],
              ['O aviso é automático mesmo?', 'Sim. Ao registrar a encomenda, os avisos entram em uma fila no servidor e são enviados sem depender da tela da portaria, com novas tentativas em caso de falha. WhatsApp depende do plano e da conexão do condomínio.'],
              ['O que acontece quando a franquia acaba?', 'A leitura de etiqueta volta à digitação manual e o WhatsApp deixa de ser enviado até o mês seguinte; o aviso no app e o e-mail continuam. Nada é cobrado a mais sem contratação.'],
              ['Quantos moradores por unidade?', 'Vários. Todos os moradores autorizados da unidade são avisados; o limite por unidade é configurado pela administração.'],
              ['Como contrato?', 'Em Configurações › Plano e assinatura: escolha o plano, leia o contrato completo e confirme o aceite. A versão aceita fica guardada com o PDF. Aceitar não é pagar: o pagamento segue por link.'],
              ['Posso exportar meus dados?', 'Relatórios exportam em CSV. Pedidos de exportação ou encerramento seguem o contrato e a política de privacidade.'],
              ['E se algo falhar?', 'Nada é considerado registrado sem confirmação do servidor. Falhas de aviso aparecem para a administração e são tentadas de novo.'],
              ['Como funciona o suporte?', 'A equipe do condomínio abre chamados com protocolo dentro do sistema e acompanha as respostas. O horário de atendimento é informado no próprio chamado.'],
            ].map(([q, a]) => <details key={q} className="rounded-xl border border-line bg-surface p-4"><summary className="cursor-pointer font-semibold min-h-6">{q}</summary><p className="mt-3 text-sm text-muted">{a}</p></details>)}
          </div>
        </section>

        {/* Modo Portaria Exclusiva: perguntas + solicitação piloto */}
        <section id="ativacao-piloto" className="bg-surface border-y border-line" aria-labelledby="piloto-h">
          <div className="max-w-6xl mx-auto px-4 py-16 grid lg:grid-cols-[1fr_1.1fr] gap-10">
            <div>
              <h2 id="piloto-h" className="text-3xl font-semibold">{KIOSK.name}: perguntas e ativação piloto</h2>
              <p className="text-muted mt-2">{KIOSK.description}</p>
              <div className="mt-6 space-y-2">
                {KIOSK_FAQ.map(([q, a]) => <details key={q} className="rounded-xl border border-line bg-bg p-4"><summary className="cursor-pointer font-semibold min-h-6">{q}</summary><p className="mt-3 text-sm text-muted">{a}</p></details>)}
              </div>
            </div>
            <Card><h3 className="font-semibold">{KIOSK.cta}</h3><p className="text-sm text-muted mt-1 mb-4">Conte qual aparelho pretende usar. A equipe confere a compatibilidade antes de liberar. Sem cobrança de ativação.</p><KioskPilotForm /></Card>
          </div>
        </section>

        <section id="contato" className="bg-surface border-t border-line" aria-labelledby="cta-h">
          <div className="max-w-6xl mx-auto px-4 py-16 grid lg:grid-cols-2 gap-10">
            <div>
              <h2 id="cta-h" className="text-3xl font-semibold">Comece pelo mês grátis</h2>
              <p className="text-muted mt-2">Cadastre o condomínio, configure a marca e registre a primeira encomenda hoje.</p>
              <Button className="mt-6" onClick={() => trial()}>Testar grátis por 1 mês</Button>
            </div>
            <Card><h3 className="font-semibold mb-3">Prefere falar com a gente?</h3><ContactForm context="landing" /></Card>
          </div>
        </section>
      </main>

      <footer className="bg-midnight text-porcelain/80">
        <div className="max-w-6xl mx-auto px-4 py-10 flex flex-wrap gap-6 justify-between items-center text-sm">
          <PortariaPrimeLogo onDark className="h-8 w-auto" />
          <nav aria-label="Rodapé" className="flex flex-wrap gap-4">
            <a href="/tutoriais" onClick={onLink} className="hover:text-porcelain">Tutoriais</a>
            <a href="/entrar" onClick={onLink} className="hover:text-porcelain">Entrar</a>
            <a href="#contato" className="hover:text-porcelain">Contato</a>
            <a href="/contrato" onClick={onLink} className="hover:text-porcelain">Contrato</a>
            <a href="/termos" onClick={onLink} className="hover:text-porcelain">Termos de uso</a>
            <a href="/privacidade" onClick={onLink} className="hover:text-porcelain">Privacidade</a>
          </nav>
          <p className="w-full text-xs text-porcelain/50">© Portaria Prime · Pagamentos por InfinitePay. Dados legais da contratada constam no contrato publicado.</p>
        </div>
      </footer>

      {zoom && (
        <div role="dialog" aria-modal="true" aria-label={zoom.title} className="fixed inset-0 z-50 bg-black/80 p-4 flex flex-col items-center justify-center" onClick={() => setZoom(null)}>
          <button autoFocus className="self-end text-white p-2 min-h-11 min-w-11" aria-label="Fechar"><X /></button>
          <img src={zoom.file} alt={`${zoom.title}: ${zoom.caption}`} className="max-h-[85vh] max-w-full rounded-xl" />
          <p className="text-white mt-3 text-sm">{zoom.title} — {zoom.caption}</p>
        </div>
      )}
    </div>
  );
}
