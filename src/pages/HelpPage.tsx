import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, LifeBuoy, Link2, PlayCircle, RotateCcw, Search } from 'lucide-react';
import { Alert, Button, Card, Input, Modal } from '../components/ui';
import { useTenant } from '../lib/tenant';
import { useSession } from '../lib/session';
import { usePwaInstall } from '../hooks/usePwaInstall';
import { navigate, query } from '../lib/router';
import { ARTICLES, Article, articlesFor, CATEGORIES, searchArticles } from '../lib/help';
import { loadProgress, resetProgress, TOURS, toursFor } from '../lib/tours';
import { SCREENS } from '../lib/screens';
import { useTour } from '../components/TourGuide';
import { ContactForm } from '../components/ContactForm';

/** Recomendados por perfil: primeiro os da tarefa mais comum de cada papel. */
const RECOMMENDED: Record<string, string[]> = {
  admin: ['primeiros-passos', 'moradores-e-convites', 'receber-encomenda', 'relatorios'],
  porteiro: ['receber-encomenda', 'entregar-encomenda', 'excecoes', 'camera'],
  morador: ['morador-chegou', 'morador-retirar', 'morador-qr-venceu', 'morador-comprovante'],
};

export default function HelpPage() {
  const t = useTenant();
  const { ctx } = useSession();
  const { start } = useTour();
  const role = t.link.role;
  const base = `/c/${t.tenant.slug}`;
  const [q, setQ] = useState('');
  const [slug, setSlug] = useState(query('artigo'));
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [contact, setContact] = useState(false);
  const [progress, setProgress] = useState(() => loadProgress(ctx!.user_id, t.tenant.id));
  useEffect(() => {
    const on = () => setSlug(query('artigo'));
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);

  const mine = useMemo(() => articlesFor(role), [role]);
  const found = useMemo(() => searchArticles(mine, q), [mine, q]);
  const recommended = useMemo(() => (RECOMMENDED[role] || []).map((s) => mine.find((a) => a.slug === s)).filter(Boolean).slice(0, 4) as Article[], [mine, role]);
  const tours = toursFor(role, (p) => t.can(p as any), t.hasModule);
  const article = mine.find((a) => a.slug === slug);
  const open = (s: string | null) => navigate(`${base}/ajuda${s ? `?artigo=${s}` : ''}`);
  const runTour = (id: string) => { const tour = TOURS.find((x) => x.id === id); if (tour) start(tour, base, ctx!.user_id, t.tenant.id); };
  const resident = role === 'morador';
  // Morador: dúvidas vão à portaria/administração do condomínio (Minha conta › Ajuda e suporte).
  // Equipe abre chamado com protocolo; morador fala com a portaria do condomínio.
  const openContact = () => navigate(resident ? `${base}/conta#ajuda` : `${base}/suporte`);
  const support = contact && <Modal title="Falar com o suporte" onClose={() => setContact(false)}><ContactForm context={`ajuda:${t.tenant.slug}`} /></Modal>;

  if (article) return <>{<ArticleView a={article} onOpen={open} onTour={runTour} canTour={!!article.tour && tours.some((x) => x.id === article.tour)} onContact={openContact} resident={resident} />}{support}</>;

  const link = (a: Article) => (
    <a href={`${base}/ajuda?artigo=${a.slug}`} onClick={(e) => { e.preventDefault(); open(a.slug); }} className="block rounded-xl border border-line bg-surface p-3 hover:bg-surface-2 min-h-11">
      <span className="font-medium">{a.title}</span><span className="block text-xs text-muted">{a.forWho}</span>
    </a>
  );

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Central de ajuda</h1><p className="text-muted text-sm mt-1">Passo a passo de cada tarefa, com tutorial dentro da tela real.</p></div>
        <Button variant="secondary" onClick={openContact}><LifeBuoy className="w-4 h-4" /> {resident ? 'Contato da portaria' : 'Falar com o suporte'}</Button>
      </div>
      <div className="relative">
        <Search className="w-5 h-5 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
        <Input aria-label="Pesquisar na ajuda" className="pl-10 h-12 text-base" placeholder={resident ? 'Pesquise: QR, comprovante, notificação…' : 'Pesquise: pacote, apartamento, QR, pagamento…'} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {q ? (
        <div className="space-y-2">
          <p className="text-sm text-muted" role="status">{found.length} resultado(s) para “{q}”.</p>
          {found.length === 0
            ? <Alert>Nada encontrado. Tente outra palavra, como “encomenda”, “unidade” ou “retirada”, ou toque em “{resident ? 'Contato da portaria' : 'Falar com o suporte'}”.</Alert>
            : <ul className="grid sm:grid-cols-2 gap-2">{found.map((a) => <li key={a.slug}>{link(a)}</li>)}</ul>}
        </div>
      ) : (
        <>
          {recommended.length > 0 && (
            <div className="space-y-2">
              <h2 className="font-semibold">Recomendados para você</h2>
              <ul className="grid sm:grid-cols-2 gap-2">{recommended.map((a) => <li key={a.slug}>{link(a)}</li>)}</ul>
            </div>
          )}

          <div className="space-y-2">
            <h2 className="font-semibold">Categorias</h2>
            <ul className="rounded-2xl border border-line bg-surface divide-y divide-line">
              {CATEGORIES.map((c) => {
                const items = mine.filter((a) => a.category === c);
                if (!items.length) return null;
                const expanded = openCat === c;
                return (
                  <li key={c}>
                    <button className="w-full flex items-center justify-between gap-2 px-4 min-h-12 text-left font-medium" aria-expanded={expanded} onClick={() => setOpenCat(expanded ? null : c)}>
                      <span>{c} <span className="text-muted text-sm font-normal">({items.length})</span></span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
                    </button>
                    {expanded && (
                      <ul className="pb-2">
                        {items.map((a) => (
                          <li key={a.slug}>
                            <a href={`${base}/ajuda?artigo=${a.slug}`} onClick={(e) => { e.preventDefault(); open(a.slug); }} className="flex items-center px-6 min-h-11 text-sm text-secondary underline-offset-2 hover:underline">{a.title}</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {tours.length > 0 && (
            <Card className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">Tutoriais guiados</h2>
                <button className="text-sm text-muted underline inline-flex items-center gap-1 min-h-11" onClick={() => { resetProgress(ctx!.user_id, t.tenant.id); setProgress({}); }}><RotateCcw className="w-4 h-4" /> Recomeçar todos</button>
              </div>
              <ul className="grid sm:grid-cols-2 gap-2">
                {tours.map((tour) => {
                  const p = progress[tour.id];
                  return (
                    <li key={tour.id} className="rounded-xl border border-line p-3 flex items-start justify-between gap-3">
                      <div className="min-w-0"><p className="font-medium">{tour.title}</p><p className="text-xs text-muted">{tour.goal} · {tour.steps.length} passos{p === 'done' ? ' · concluído' : typeof p === 'number' ? ` · parou no passo ${p + 1}` : ''}</p></div>
                      <Button variant="secondary" onClick={() => runTour(tour.id)} aria-label={`${p === 'done' ? 'Rever' : 'Iniciar'} tutorial ${tour.title}`}><PlayCircle className="w-4 h-4" />{p === 'done' ? 'Rever' : 'Iniciar'}</Button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {!resident && <InstallCard />}
        </>
      )}
      {support}
    </section>
  );
}

function ArticleView({ a, onOpen, onTour, canTour, onContact, resident }: { a: Article; onOpen: (s: string | null) => void; onTour: (id: string) => void; canTour: boolean; onContact: () => void; resident: boolean }) {
  const shot = a.screen ? SCREENS[a.screen] : null;
  const [copied, setCopied] = useState(false);
  const related = a.next.map((s) => ARTICLES.find((x) => x.slug === s)).filter(Boolean) as Article[];
  return (
    <article className="space-y-4 max-w-3xl">
      <nav aria-label="Trilha" className="text-sm text-muted"><button className="underline min-h-11" onClick={() => onOpen(null)}>Ajuda</button> › {a.category}</nav>
      <h1 className="text-2xl font-semibold">{a.title}</h1>
      <div className="flex flex-wrap gap-2">
        {canTour && <Button onClick={() => onTour(a.tour!)}><PlayCircle className="w-4 h-4" /> Fazer o tutorial nesta tela</Button>}
        <Button variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { /* sem clipboard */ } }}><Link2 className="w-4 h-4" />{copied ? 'Link copiado' : 'Copiar link'}</Button>
      </div>
      <Card className="space-y-4 text-sm leading-relaxed">
        {!resident && <p><strong>Para quem:</strong> {a.forWho}</p>}
        <p><strong>Quando usar:</strong> {a.when}</p>
        {a.before.length > 0 && <div><p className="font-semibold">Antes de começar</p><ul className="list-disc pl-5">{a.before.map((b) => <li key={b}>{b}</li>)}</ul></div>}
        <div><p className="font-semibold">Passo a passo</p><ol className="list-decimal pl-5 space-y-1">{a.steps.map((s) => <li key={s}>{s}</li>)}</ol></div>
        {shot && <figure><img src={shot.file} alt={`${shot.title}: ${shot.caption}`} width={shot.width} height={shot.height} loading="lazy" className="w-full h-auto rounded-xl border border-line" /><figcaption className="text-xs text-muted mt-1">Tela com dados de demonstração; o menu pode ter mudado de lugar.</figcaption></figure>}
        <p><strong>Resultado esperado:</strong> {a.result}</p>
        <p><strong>{resident ? 'Como confirmar:' : 'Como confirmar que salvou:'}</strong> {a.confirm}</p>
        {a.problems.length > 0 && <div><p className="font-semibold">Problemas comuns</p><dl className="space-y-2">{a.problems.map(([p, s]) => <div key={p}><dt className="font-medium">{p}</dt><dd className="text-muted">{s}</dd></div>)}</dl></div>}
      </Card>
      {related.length > 0 && <div><p className="font-semibold mb-2">Próximos passos</p><ul className="space-y-1">{related.map((r) => <li key={r.slug}><button className="underline text-secondary min-h-11 text-left" onClick={() => onOpen(r.slug)}>{r.title}</button></li>)}</ul></div>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Revisado em 22/10/2026 · versão 2.</p>
        <Button variant="ghost" onClick={onContact}><LifeBuoy className="w-4 h-4" /> Não resolveu? {resident ? 'Contato da portaria' : 'Falar com o suporte'}</Button>
      </div>
    </article>
  );
}

function InstallCard() {
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  return (
    <Card><h2 className="font-semibold">Instalar no dispositivo</h2>
      {isInstalled ? <p className="text-sm">Aplicativo instalado neste dispositivo.</p> : isInstallable ? <Button variant="secondary" className="mt-2" onClick={promptInstall}>Instalar aplicativo</Button> : <p className="text-sm text-muted">No iPhone: Safari › Compartilhar › Adicionar à Tela de Início. Em outros navegadores, procure “Instalar” no menu. Requer HTTPS e navegador compatível.</p>}
    </Card>
  );
}
