import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft } from 'lucide-react';
import { friendly, rpc } from '../lib/api';
import { loadCatalog, featureList, PlanRow } from '../lib/catalog';
import { brl, CYCLE_LABEL, dateTime } from '../lib/format';
import { navigate, onLink, query } from '../lib/router';
import { useSession } from '../lib/session';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';
import { KioskPlanNote } from '../components/KioskPilotForm';
import { track } from '../lib/funnel';

const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

const TIMEZONES = ['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Porto_Velho', 'America/Rio_Branco', 'America/Noronha'];
const STEPS = ['Condomínio', 'Plano', 'Revisão', 'Pronto'];
type Cycle = 'monthly' | 'quarterly' | 'yearly';
type Draft = { name: string; slug: string; document: string; phone: string; timezone: string; plan: string; cycle: Cycle };
type Tenant = { tenant_id: string; slug: string; name: string; plan: string; cycle: Cycle; status: string; trial_started_at: string; trial_ends_at: string };
type State = { draft: { step: number; data: Partial<Draft>; request_id: string; updated_at: string } | null; tenant: Tenant | null; now: string; trial_end_preview: string };

/** CPF/CNPJ: dígitos verificadores (o servidor confere tamanho e unicidade). */
export function validDocument(raw: string) {
  const d = raw.replace(/\D/g, '');
  if (/^(\d)\1+$/.test(d)) return false;
  const dv = (base: string, w: number[]) => { const s = base.split('').reduce((a, c, i) => a + +c * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  if (d.length === 11) return dv(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[9] && dv(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[10];
  if (d.length === 14) return dv(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[12] && dv(d.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[13];
  return false;
}

/**
 * Cadastro do condomínio em etapas (dados → plano → revisão → ativação do mês grátis).
 * O rascunho vive no servidor (onboarding_save/onboarding_state): avançar, voltar, F5 ou outro
 * aparelho retomam a etapa certa. A ativação usa o request_id do rascunho em provision_tenant
 * (idempotente): duplo clique, retry ou refresh nunca criam dois condomínios.
 */
export function OnboardingPage() {
  const { ctx, refresh } = useSession();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [step, setStep] = useState(1);
  const [f, setF] = useState<Draft>({ name: '', slug: '', document: '', phone: '', timezone: 'America/Sao_Paulo', plan: query('plano') || 'profissional', cycle: (query('ciclo') as Cycle) || 'monthly' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugFree, setSlugFree] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [terms, setTerms] = useState(false); // nunca pré-marcado
  const activating = useRef(false);

  // "Cadastrar outro condomínio" é intenção explícita; lida uma vez (a URL é limpa para o F5 não reiniciar).
  const [fresh, setFresh] = useState(() => query('novo') === '1');
  const load = async (another = fresh) => {
    setError(null);
    try {
      let [p, s] = await Promise.all([loadCatalog(), rpc<State>('onboarding_state', { p_timezone: f.timezone })]);
      // Rascunho novo; o condomínio já criado não é tocado.
      if (s.tenant && another) { await rpc('onboarding_reset'); s = await rpc<State>('onboarding_state', { p_timezone: f.timezone }); }
      if (query('novo')) history.replaceState(null, '', '/onboarding');
      setPlans(p);
      setState(s);
      if (s.tenant) { setStep(4); return; }
      if (s.draft) {
        setF((cur) => ({ ...cur, ...s.draft!.data }));
        if (s.draft.data.slug) setSlugTouched(true);
        setStep(Math.min(s.draft.step, 3));
      }
    } catch (e: any) { setError(friendly(e)); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!slugTouched) setF((c) => ({ ...c, slug: slugify(c.name) })); }, [f.name, slugTouched]);
  useEffect(() => {
    if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(f.slug)) { setSlugFree(null); return; }
    const t = setTimeout(() => { rpc<boolean>('slug_available', { p_slug: f.slug }).then(setSlugFree).catch(() => setSlugFree(null)); }, 400);
    return () => clearTimeout(t);
  }, [f.slug]);

  const selectable = useMemo(() => (plans || []).filter((p) => p.published && !p.is_custom && p.prices.length), [plans]);
  const chosen = selectable.find((p) => p.code === f.plan) || selectable[0];
  const price = chosen?.prices.find((p) => p.cycle === f.cycle);

  if (ctx && !ctx.email_verified) {
    return <Shell step={1}><Alert tone="warning">Confirme seu e-mail pelo link enviado e entre novamente para cadastrar o condomínio.</Alert></Shell>;
  }

  /** Grava o rascunho no servidor e avança. Falha de rede mantém a etapa e os campos. */
  const save = async (next: number) => {
    setSaving('saving'); setError(null);
    try {
      const { document: _d, ...rest } = f;
      const d = await rpc<{ step: number; request_id: string; updated_at: string }>('onboarding_save', { p_step: next, p_data: { ...rest, document: f.document.replace(/\D/g, '') } });
      setState((s) => s && { ...s, draft: { ...d, data: f } });
      setSaving('saved'); setStep(next); window.scrollTo(0, 0);
    } catch (e: any) { setSaving('idle'); setError(friendly(e)); }
  };

  const next1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validDocument(f.document)) return setError('CNPJ ou CPF inválido. Confira os dígitos.');
    if (slugFree === false) return setError('Este endereço já está em uso. Escolha outro.');
    void save(2);
  };

  const activate = async () => {
    if (activating.current || !chosen || !price || !terms || !state?.draft) return;
    activating.current = true; setBusy(true); setError(null);
    try {
      const r = await rpc<{ slug: string; tenant_id: string; replayed: boolean }>('provision_tenant', {
        p_request_id: state.draft!.request_id, p_name: f.name.trim(), p_slug: f.slug, p_document: f.document, p_timezone: f.timezone,
        p_plan_code: chosen.code, p_cycle: f.cycle, p_contact_phone: f.phone || null,
      });
      // Aceite dos termos do TESTE (não é contrato de compra). Falha aqui não desfaz o condomínio.
      await rpc('record_trial_consent', { p_tenant: r.tenant_id }).catch((e) => console.warn('consentimento', e));
      if (!r.replayed) track('trial_started', chosen.code);
      await refresh();
      const s = await rpc<State>('onboarding_state', { p_timezone: f.timezone });
      setState(s); setStep(4); window.scrollTo(0, 0);
    } catch (err: any) {
      setError(friendly(err));
    } finally { setBusy(false); activating.current = false; }
  };

  if (error && !state) return <Shell step={step}><Alert tone="danger">{error}</Alert><Button className="mt-4" onClick={() => load()}>Tentar novamente</Button></Shell>;
  if (!plans || !state) return <Shell step={step}><Skeleton /></Shell>;
  if (step === 4 && state.tenant) return <Shell step={4}><Success t={state.tenant} /></Shell>;
  const admin = ctx?.tenants.find((t) => t.role === 'admin' && t.tenant_status === 'active');
  if (admin && !state.draft && !fresh) return (
    <Shell step={1}><Card className="max-w-xl space-y-3">
      <h1 className="text-xl font-semibold">Você já administra o {admin.name}</h1>
      <p className="text-sm text-muted">Seu teste ou assinatura continua por lá. Quer cadastrar outro condomínio?</p>
      <div className="flex flex-col sm:flex-row gap-3"><Button onClick={() => navigate(`/c/${admin.slug}/painel`, true)}>Acessar meu painel</Button>
        <Button variant="secondary" onClick={() => setFresh(true)}>Cadastrar outro condomínio</Button></div>
    </Card></Shell>
  );
  if (selectable.length === 0) return <Shell step={step}><Alert tone="warning">Nenhum plano foi publicado para contratação. O administrador da plataforma precisa revisar e publicar o catálogo.</Alert><Button variant="secondary" className="mt-4" onClick={() => load()}>Verificar novamente</Button></Shell>;

  const back = () => { setError(null); setStep(step - 1); window.scrollTo(0, 0); };
  const summary = chosen && price && (
    <Card className="space-y-2 text-sm">
      <p className="font-semibold">{chosen.name} · {CYCLE_LABEL[f.cycle]}</p>
      <p>Primeiro mês grátis; depois <strong>{brl(price.amount_cents)}</strong> por ciclo {CYCLE_LABEL[f.cycle].toLowerCase()}.</p>
      <p className="text-muted">Teste até <strong>{dateTime(state.trial_end_preview, f.timezone)}</strong> (um mês de calendário contado pelo servidor no momento da ativação).</p>
      <p className="text-muted">Sem cartão e sem cobrança durante o teste. Ao final, geramos o link de pagamento — sem débito automático. Cancele quando quiser em Assinatura.</p>
      <ul className="pt-2 space-y-1">{featureList(chosen).map((x) => <li key={x} className="flex gap-2"><Check className="w-4 h-4 text-success shrink-0 mt-0.5" />{x}</li>)}</ul>
      <KioskPlanNote />
    </Card>
  );

  return (
    <Shell step={step}>
      {step === 1 && (
        <form onSubmit={next1} className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div>
            <h1 className="text-2xl font-semibold">Dados do condomínio</h1>
            <p className="text-muted mt-1">Conectado como <strong>{ctx?.email}</strong>. Só o necessário para criar o ambiente — o resto você configura depois.</p>
            <Card className="mt-6 space-y-4">
              <Field label="Nome do condomínio"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} autoFocus /></Field>
              <Field label="Endereço no sistema" hint={slugFree === false ? undefined : `Seu condomínio ficará em ${location.host}/c/${f.slug || '…'}`} error={slugFree === false ? 'Este endereço já está em uso. Escolha outro.' : null}>
                <Input required pattern="[a-z0-9][a-z0-9\-]{1,46}[a-z0-9]" value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: slugify(e.target.value) }); }} />
              </Field>
              <Field label="CNPJ do condomínio (ou CPF do responsável)" hint="Garante um mês grátis por condomínio." error={f.document.replace(/\D/g, '').length >= 11 && !validDocument(f.document) ? 'Documento inválido.' : null}>
                <Input required inputMode="numeric" autoComplete="off" value={f.document} onChange={(e) => setF({ ...f, document: e.target.value })} />
              </Field>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Telefone de contato (opcional)"><Input type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
                <Field label="Fuso horário"><Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
              </div>
              {error && <Alert tone="danger">{error}</Alert>}
              <Nav saving={saving} next="Escolher o plano" />
            </Card>
          </div>
          <aside className="space-y-3 text-sm">
            <Card><p className="font-semibold">Como funciona o teste</p><p className="text-muted mt-1">Um mês de calendário grátis, sem cartão. Você escolhe o plano que valerá depois e só paga se quiser continuar.</p></Card>
            <Card><p className="font-semibold">Seus dados ficam salvos</p><p className="text-muted mt-1">Pode fechar e voltar depois: o cadastro continua de onde parou.</p></Card>
          </aside>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={(e) => { e.preventDefault(); void save(3); }} className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div>
            <h1 className="text-2xl font-semibold">Plano após o teste</h1>
            <p className="text-muted mt-1">Nada é cobrado agora. Você pode trocar o plano e a periodicidade até a confirmação — e depois, em Assinatura.</p>
            <Card className="mt-6 space-y-3">
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Periodicidade">
                {(['monthly', 'quarterly', 'yearly'] as const).map((c) => (
                  <button type="button" key={c} role="radio" aria-checked={f.cycle === c} onClick={() => setF({ ...f, cycle: c })}
                    className={`min-h-10 rounded-lg text-sm font-medium ${f.cycle === c ? 'bg-surface shadow text-text' : 'text-muted'}`}>{CYCLE_LABEL[c]}</button>
                ))}
              </div>
              {selectable.map((p) => {
                const pr = p.prices.find((x) => x.cycle === f.cycle);
                return (
                  <label key={p.code} className={`flex gap-3 rounded-xl border p-3 cursor-pointer ${chosen?.code === p.code ? 'border-secondary ring-1 ring-secondary' : 'border-line'}`}>
                    <input type="radio" name="plan" className="mt-1" checked={chosen?.code === p.code} onChange={() => setF({ ...f, plan: p.code })} />
                    <span className="flex-1">
                      <span className="flex justify-between font-semibold"><span>{p.name}</span><span>{pr ? brl(pr.amount_cents) : '—'}</span></span>
                      <span className="block text-xs text-muted">{p.ent ? `Até ${p.ent.max_units} unidades · ${p.ent.max_concierges} portaria(s)` : ''}{f.cycle !== 'monthly' && pr ? ` · total do ciclo ${CYCLE_LABEL[f.cycle].toLowerCase()}` : ''}</span>
                    </span>
                  </label>
                );
              })}
              {error && <Alert tone="danger">{error}</Alert>}
              <Nav saving={saving} next="Revisar e ativar" onBack={back} disabled={!chosen || !price} />
            </Card>
          </div>
          <aside>{summary}</aside>
        </form>
      )}

      {step === 3 && chosen && price && (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div>
            <h1 className="text-2xl font-semibold">Revise e ative o mês grátis</h1>
            <p className="text-muted mt-1">Confira os dados. A ativação cria o condomínio e inicia o teste na hora.</p>
            <Card className="mt-6 space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {([['Condomínio', f.name], ['Endereço', `${location.host}/c/${f.slug}`], ['Documento', f.document], ['Responsável', ctx?.email], ['Telefone', f.phone || '—'], ['Fuso horário', f.timezone],
                  ['Plano', chosen.name], ['Periodicidade', CYCLE_LABEL[f.cycle]], ['Duração do teste', 'Um mês de calendário, sem cartão']] as [string, string | undefined][])
                  .map(([k, v]) => <React.Fragment key={k}><dt className="text-muted">{k}</dt><dd className="font-medium break-words">{v}</dd></React.Fragment>)}
              </dl>
              <label className="flex gap-3 items-start text-sm">
                <input type="checkbox" className="mt-1 w-5 h-5 shrink-0" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
                <span>Li e aceito os <a href="/termos" target="_blank" className="underline">Termos de uso</a> e a <a href="/privacidade" target="_blank" className="underline">Política de privacidade</a> para o período de teste. A contratação paga tem contrato próprio.</span>
              </label>
              {error && <Alert tone="danger">{error}</Alert>}
              <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-between pt-2">
                <Button type="button" variant="ghost" onClick={back} disabled={busy}><ChevronLeft className="w-4 h-4" /> Voltar e editar</Button>
                <Button type="button" onClick={activate} loading={busy} disabled={!terms || busy} className="sm:min-w-64">{busy ? 'Ativando…' : 'Confirmar e ativar mês grátis'}</Button>
              </div>
            </Card>
          </div>
          <aside>{summary}</aside>
        </div>
      )}
    </Shell>
  );
}

function Nav({ saving, next, onBack, disabled }: { saving: string; next: string; onBack?: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col-reverse sm:flex-row gap-3 sm:items-center sm:justify-between pt-2">
      {onBack ? <Button type="button" variant="ghost" onClick={onBack}><ChevronLeft className="w-4 h-4" /> Voltar</Button> : <span />}
      <div className="flex items-center gap-3 sm:justify-end">
        <span className="text-xs text-muted" aria-live="polite">{saving === 'saving' ? 'Salvando…' : saving === 'saved' ? 'Salvo' : ''}</span>
        <Button type="submit" loading={saving === 'saving'} disabled={disabled} className="flex-1 sm:flex-none sm:min-w-48">{next}</Button>
      </div>
    </div>
  );
}

function Success({ t }: { t: Tenant }) {
  const url = `${location.origin}/c/${t.slug}`;
  return (
    <div className="max-w-2xl mx-auto text-center">
      <span className="mx-auto grid place-items-center w-16 h-16 rounded-full bg-success/10 text-success"><Check className="w-8 h-8" aria-hidden /></span>
      <h1 className="mt-4 text-3xl font-semibold">Seu condomínio está pronto!</h1>
      <p className="mt-2 text-muted">O mês grátis do <strong>{t.name}</strong> começou. Nada será cobrado sem a sua confirmação.</p>
      <Card className="mt-6 text-left">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {([['Condomínio', t.name], ['Plano após o teste', `${t.plan} · ${CYCLE_LABEL[t.cycle]}`], ['Início do teste', dateTime(t.trial_started_at)], ['Fim do teste', dateTime(t.trial_ends_at)], ['Endereço', url]] as [string, string][])
            .map(([k, v]) => <React.Fragment key={k}><dt className="text-muted">{k}</dt><dd className="font-medium break-all">{v}</dd></React.Fragment>)}
        </dl>
      </Card>
      <Card className="mt-3 text-left text-sm">
        <p className="font-semibold">Próximos passos recomendados</p>
        <ol className="mt-2 list-decimal pl-5 space-y-1 text-muted">
          <li>Identidade visual: logo e cores do condomínio.</li>
          <li>Portaria e locais de guarda (estantes e prateleiras).</li>
          <li>Unidades e convite da equipe da portaria.</li>
          <li>Divulgação do portal aos moradores.</li>
        </ol>
      </Card>
      <Button className="mt-6 w-full sm:w-auto sm:min-w-64" onClick={() => navigate(`/c/${t.slug}/configuracoes?inicio=1`, true)}>Acessar meu painel</Button>
      <p className="mt-4 text-xs text-muted">Precisa cadastrar outro condomínio? <a href="/app" onClick={onLink} className="underline">Veja seus condomínios</a>.</p>
    </div>
  );
}

function Skeleton() {
  return <div className="grid gap-6 lg:grid-cols-[1fr_360px] animate-pulse" aria-busy><div className="space-y-4"><div className="h-8 w-2/3 rounded bg-surface-2" /><div className="h-72 rounded-2xl bg-surface-2" /></div><div className="h-40 rounded-2xl bg-surface-2" /></div>;
}

function Shell({ step, children }: { step: number; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface"><div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between"><a href="/" onClick={onLink} aria-label="Portaria Prime"><PortariaPrimeLogo className="h-8 w-auto" /></a><span className="text-xs text-muted hidden sm:inline">Primeiro mês grátis · sem cartão</span></div></header>
      <main className="max-w-6xl mx-auto px-4 py-8">
        <ol className="mb-8 flex gap-2 text-xs sm:text-sm" aria-label="Etapas do cadastro">
          {STEPS.map((s, i) => { const n = i + 1; const on = n === step; const done = n < step; return (
            <li key={s} aria-current={on ? 'step' : undefined} className={`flex-1 border-t-2 pt-2 ${on ? 'border-secondary text-text font-semibold' : done ? 'border-success text-muted' : 'border-line text-muted'}`}>{done ? '✓ ' : `${n}. `}{s}</li>
          ); })}
        </ol>
        {children}
      </main>
    </div>
  );
}
