// /contrato, /termos e /privacidade: versão publicada vigente (servidor) ou a minuta
// empacotada com faixa "não vigente". Nenhum dado da contratada é inventado.
import React, { useEffect, useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { dateOnly } from '../lib/format';
import { onLink } from '../lib/router';
import { draftDoc, headings, LegalDoc, LegalKind, LEGAL_LABEL, Markdown } from '../lib/legal';
import { Alert, Button, Spinner } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';

/** Versão publicada ou, na falta dela (ou do servidor), a minuta local. */
export function useLegalDoc(kind: LegalKind) {
  const [state, setState] = useState<{ doc: LegalDoc | null; published: boolean } | null>(null);
  useEffect(() => {
    let on = true;
    supabase.rpc('legal_document_current', { p_kind: kind }).then(({ data, error }) => {
      if (!on) return;
      setState(!error && data ? { doc: data as LegalDoc, published: true } : { doc: draftDoc(kind), published: false });
    }, () => on && setState({ doc: draftDoc(kind), published: false }));
    return () => { on = false; };
  }, [kind]);
  return state;
}

function LegalPage({ kind }: { kind: LegalKind }) {
  const st = useLegalDoc(kind);
  const doc = st?.doc;
  const toc = useMemo(() => (doc ? headings(doc.content_md) : []), [doc]);
  useEffect(() => { document.title = `${LEGAL_LABEL[kind]} — Portaria Prime`; }, [kind]);
  const save = () => {
    if (!doc) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([doc.content_md], { type: 'text/markdown;charset=utf-8' }));
    a.download = `portaria-prime-${kind}-${doc.version}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface print:hidden">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <a href="/" onClick={onLink} aria-label="Início"><PortariaPrimeLogo className="h-8 w-auto" /></a>
          <nav className="flex gap-3 text-sm" aria-label="Documentos legais">
            {([['/contrato', 'Contrato'], ['/termos', 'Termos'], ['/privacidade', 'Privacidade']] as const).map(([href, label]) =>
              <a key={href} href={href} onClick={onLink} className="underline-offset-4 hover:underline" aria-current={location.pathname === href ? 'page' : undefined}>{label}</a>)}
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8 grid gap-8 lg:grid-cols-[220px_1fr]">
        {!st ? <Spinner /> : !doc ? <Alert tone="warning">Documento indisponível.</Alert> : <>
          <aside className="print:hidden lg:sticky lg:top-6 self-start space-y-2">
            {toc.length > 0 && <nav aria-label="Índice" className="text-sm"><p className="font-semibold mb-2">Índice</p>
              <ol className="space-y-1">{toc.map((h) => <li key={h.id} className={h.level === 3 ? 'pl-3' : ''}><a href={`#${h.id}`} className="text-muted hover:text-text">{h.text}</a></li>)}</ol>
            </nav>}
          </aside>
          <article className="min-w-0 space-y-5">
            <div className="space-y-2">
              <h1 className="text-2xl sm:text-3xl font-semibold">{LEGAL_LABEL[kind]}</h1>
              <p className="text-sm text-muted">Versão {doc.version}{st.published && doc.effective_from ? ` · vigente desde ${dateOnly(doc.effective_from)}` : ''}</p>
              {kind === 'contrato_saas' ? <Alert>Modelo oficial. Os campos destacados (condomínio, síndico e plano) são preenchidos automaticamente com os dados informados no momento da contratação, e o contrato é assinado eletronicamente pelas duas partes na Autentique.</Alert>
                : !st.published && <Alert tone="warning"><strong>Minuta em revisão — não vigente.</strong> Este texto ainda não foi aprovado juridicamente nem publicado; campos marcados como "a definir" dependem de dados da empresa ainda não cadastrados.</Alert>}
            </div>
            {doc.summary && <section className="rounded-2xl border border-line bg-surface-2 p-4" aria-label="Resumo em linguagem simples">
              <p className="font-semibold mb-1">Resumo em linguagem simples</p><p className="text-sm">{doc.summary}</p>
              <p className="text-xs text-muted mt-2">O resumo ajuda a leitura; vale o texto completo abaixo.</p>
            </section>}
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button variant="secondary" onClick={() => print()}><Printer className="w-4 h-4" aria-hidden />Imprimir ou salvar em PDF</Button>
              <Button variant="ghost" onClick={save}><Download className="w-4 h-4" aria-hidden />Baixar texto</Button>
            </div>
            <Markdown md={doc.content_md} />
            {st.published && doc.sha256 && <p className="text-xs text-muted break-all">SHA-256 deste texto: {doc.sha256}</p>}
          </article>
        </>}
      </main>
    </div>
  );
}

export const ContratoPage = () => <LegalPage kind="contrato_saas" />;
export const TermosPage = () => <LegalPage kind="termos" />;
export const PrivacidadePage = () => <LegalPage kind="privacidade" />;
