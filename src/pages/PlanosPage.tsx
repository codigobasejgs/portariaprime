// /planos — escolha do plano com o contrato montado na tela, já preenchido com os dados informados.
// Preços e limites vêm do catálogo publicado (servidor). O envio registra um pedido de contratação
// com protocolo; o aceite formal (verificação do representante, PDF e trilha) é feito em /contratar.
import React, { useEffect, useMemo, useState } from 'react';
import { Check, FileText, MessageCircle, Printer } from 'lucide-react';
import { PortariaPrimeLogo } from '../components/Brand';
import { Alert, Badge, Button, Field, Input, Select, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { KioskPlanNote } from '../components/KioskPilotForm';
import { featureList, loadCatalog, PlanRow } from '../lib/catalog';
import { KIOSK } from '../lib/kiosk-offer';
import { brl, CYCLE_LABEL, CYCLE_MONTHS } from '../lib/format';
import { track } from '../lib/funnel';
import { headings, Markdown } from '../lib/legal';
import { navigate, onLink, query } from '../lib/router';
import { useSession } from '../lib/session';
import { useLegalDoc } from './LegalPages';

type Cycle = 'monthly' | 'quarterly' | 'yearly';
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
const SALES_WHATSAPP = (import.meta.env.VITE_SALES_WHATSAPP as string | undefined)?.replace(/\D/g, '') || '';
const empty = { condoName: '', cnpj: '', units: '', city: '', uf: '', repName: '', repRole: 'Síndico(a)', repEmail: '', repPhone: '', website: '' };

const maskCnpj = (v: string) => v.replace(/\D/g, '').slice(0, 14).replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
const maskPhone = (v: string) => v.replace(/\D/g, '').slice(0, 11).replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{4})$/, '$1-$2');
const discountPct = (monthly: number, total: number, months: number) => Math.round((1 - total / (monthly * months)) * 100);

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Contrato com os dados desta contratação no lugar dos campos do contratante (só na tela; o documento base não muda). */
function fillContract(md: string, f: typeof empty, plan: PlanRow | null, cycle: Cycle, amount: number | null) {
  const v: Record<string, string> = {
    CONDOMINIO_NOME: f.condoName, CONDOMINIO_CNPJ: f.cnpj, CONDOMINIO_ENDERECO: f.city ? `${f.city}${f.uf ? `/${f.uf}` : ''}` : '',
    SINDICO_NOME: f.repName, SINDICO_EMAIL: f.repEmail, SINDICO_TELEFONE: f.repPhone,
    PLANO_NOME: plan ? `${plan.name} (${CYCLE_LABEL[cycle].toLowerCase()})` : '',
    PLANO_VALOR_MENSAL: amount != null ? brl(Math.round(amount / CYCLE_MONTHS[cycle])).replace(/^R\$\s?/, '') : '',
    PLANO_LIMITE_DESCRICAO: plan?.ent ? `até ${plan.ent.max_units} unidades e ${plan.ent.max_concierges} portaria(s)` : '',
  };
  return md.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (v[k]?.trim() ? `**${v[k].trim()}**` : m));
}

export default function PlanosPage() {
  const { session } = useSession();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [planCode, setPlanCode] = useState(query('plano') || 'profissional');
  const [cycle, setCycle] = useState<Cycle>(((['monthly', 'quarterly', 'yearly'] as const).find((c) => c === query('ciclo'))) || 'yearly');
  const [f, setF] = useState(empty);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ protocol: string; plan: string; cycle: Cycle; amount_cents: number } | null>(null);
  const legal = useLegalDoc('contrato_saas');

  useEffect(() => { document.title = 'Planos e contrato · Portaria Prime'; loadCatalog().then(setPlans).catch(() => setCatalogError(true)); }, []);
  const selectable = (plans || []).filter((p) => p.published && !p.is_custom && p.prices.length);
  const plan = selectable.find((p) => p.code === planCode) || null;
  const price = (p: PlanRow | null, c: Cycle) => p?.prices.find((x) => x.cycle === c)?.amount_cents ?? null;
  const amount = price(plan, cycle);
  const monthly = price(plan, 'monthly');
  const filled = useMemo(() => (legal?.doc ? fillContract(legal.doc.content_md, f, plan, cycle, amount) : ''), [legal, f, plan, cycle, amount]);
  const toc = useMemo(() => (legal?.doc ? headings(legal.doc.content_md) : []), [legal]);
  const set = (k: keyof typeof empty, mask?: (v: string) => string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: mask ? mask(e.target.value) : e.target.value }));
  const ready = !!plan && amount != null && f.condoName.trim().length >= 2 && f.repName.trim().length >= 2 && /\S+@\S+\.\S+/.test(f.repEmail) && agree;

  const summary = () => [
    `*Pedido de contratação Portaria Prime*${done ? ` (${done.protocol})` : ''}`,
    `Plano: ${plan?.name} · ${CYCLE_LABEL[cycle]} · ${amount != null ? brl(amount) : ''} por ciclo`,
    `Condomínio: ${f.condoName}${f.cnpj ? ` · CNPJ ${f.cnpj}` : ''}${f.units ? ` · ${f.units} unidades` : ''}`,
    `Representante: ${f.repName} (${f.repRole})`,
    `Contrato lido: versão ${legal?.doc?.version}`,
  ].join('\n');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !legal?.doc) return;
    setBusy(true); setError(null);
    try {
      const documentSha256 = legal.doc.sha256 || await sha256(legal.doc.content_md);
      const r = await api<{ protocol: string; amount_cents: number }>('/api/plan-request', {
        plan: planCode, cycle, condoName: f.condoName, cnpj: f.cnpj, units: f.units ? Number(f.units) : null, city: f.city, uf: f.uf || null,
        repName: f.repName, repRole: f.repRole, repEmail: f.repEmail, repPhone: f.repPhone, agree, documentSha256, documentVersion: legal.doc.version, website: f.website,
      });
      track('cta_trial_click', planCode);
      setDone({ protocol: r.protocol, plan: plan!.name, cycle, amount_cents: r.amount_cents });
    } catch (err: any) { setError(err.message || 'Não foi possível enviar agora. Tente de novo.'); } finally { setBusy(false); }
  };
  const startTrial = () => navigate(session ? `/onboarding?plano=${planCode}&ciclo=${cycle}` : `/cadastro?next=${encodeURIComponent(`/onboarding?plano=${planCode}&ciclo=${cycle}`)}`);

  const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <section aria-labelledby={`etapa-${n}`} className="rounded-2xl border border-line bg-surface p-5 sm:p-6 space-y-4 print:border-0 print:p-0">
      <h2 id={`etapa-${n}`} className="text-xl font-semibold flex items-center gap-3"><span className="h-8 w-8 rounded-full bg-midnight text-porcelain grid place-items-center text-sm print:hidden">{n}</span>{title}</h2>
      {children}
    </section>
  );

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="border-b border-line bg-surface print:hidden">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <a href="/" onClick={onLink} aria-label="Portaria Prime, início"><PortariaPrimeLogo className="h-8 w-auto" /></a>
          <nav aria-label="Atalhos" className="flex gap-4 text-sm"><a href="/tutoriais" onClick={onLink} className="hover:underline">Tutoriais</a><a href="/entrar" onClick={onLink} className="font-semibold">Entrar</a></nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="print:hidden">
          <h1 className="text-3xl font-semibold">Planos e contrato</h1>
          <p className="text-muted mt-2 max-w-3xl">Escolha o plano e o ciclo, preencha os dados do condomínio e leia o contrato já montado com essas informações. Em seguida, envie o pedido ou comece direto pelo mês grátis.</p>
        </div>

        <Step n={1} title="Escolha o plano">
          <div role="radiogroup" aria-label="Ciclo de pagamento" className="inline-grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
            {(['monthly', 'quarterly', 'yearly'] as const).map((c) => {
              const ref = selectable[0];
              const pct = ref && price(ref, 'monthly') && price(ref, c) ? discountPct(price(ref, 'monthly')!, price(ref, c)!, CYCLE_MONTHS[c]) : 0;
              return <button key={c} type="button" role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)}
                className={`min-h-11 px-3 sm:px-4 rounded-lg text-sm font-medium ${cycle === c ? 'bg-surface shadow text-text' : 'text-muted'}`}>
                {CYCLE_LABEL[c]}{pct > 0 && <span className="ml-1 text-success font-semibold">−{pct}%</span>}</button>;
            })}
          </div>
          {catalogError ? <Alert tone="danger">Não foi possível carregar os planos. Recarregue a página.</Alert> : !plans ? <Spinner /> : (
            <div role="radiogroup" aria-label="Plano" className="grid md:grid-cols-3 gap-3">
              {selectable.map((p) => {
                const total = price(p, cycle); const m = price(p, 'monthly');
                const pct = total && m && cycle !== 'monthly' ? discountPct(m, total, CYCLE_MONTHS[cycle]) : 0;
                const on = p.code === planCode;
                return (
                  <button key={p.code} type="button" role="radio" aria-checked={on} onClick={() => setPlanCode(p.code)}
                    className={`text-left rounded-2xl border p-4 flex flex-col gap-2 min-h-11 ${on ? 'border-secondary ring-2 ring-secondary bg-surface' : 'border-line bg-bg hover:bg-surface'}`}>
                    <span className="flex items-center justify-between gap-2"><span className="text-lg font-semibold">{p.name}</span>{on && <Check className="w-5 h-5 text-secondary" aria-hidden />}</span>
                    {total != null ? <>
                      <span><span className="text-2xl font-semibold">{brl(total)}</span> <span className="text-sm text-muted">{cycle === 'monthly' ? 'por mês' : `a cada ${CYCLE_MONTHS[cycle]} meses`}</span></span>
                      {cycle !== 'monthly' && m && <span className="text-sm">equivale a <strong>{brl(Math.round(total / CYCLE_MONTHS[cycle]))}/mês</strong>{pct > 0 && <Badge tone="success">economia de {brl(m * CYCLE_MONTHS[cycle] - total)} ({pct}%)</Badge>}</span>}
                    </> : <span className="text-sm text-muted">Ciclo indisponível.</span>}
                    <ul className="text-sm space-y-1 mt-1">{[...featureList(p).slice(0, 5), KIOSK.feature].map((x) => <li key={x} className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-success shrink-0" aria-hidden />{x}</li>)}</ul>
                    <KioskPlanNote />
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted">Valores após o mês grátis. Ciclo trimestral ou anual é pago de uma vez, por link (Pix ou cartão), sem débito automático. Preços valem para novas contratações; contratos existentes não são reajustados automaticamente.</p>
        </Step>

        <form onSubmit={submit} className="space-y-6">
          <Step n={2} title="Dados do condomínio e do representante">
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Nome do condomínio"><Input required maxLength={200} value={f.condoName} onChange={set('condoName')} autoComplete="organization" /></Field>
              <Field label="CNPJ do condomínio (opcional)"><Input inputMode="numeric" value={f.cnpj} onChange={set('cnpj', maskCnpj)} placeholder="00.000.000/0000-00" /></Field>
              <Field label="Número de unidades (opcional)"><Input inputMode="numeric" value={f.units} onChange={set('units', (v) => v.replace(/\D/g, '').slice(0, 5))} /></Field>
              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <Field label="Cidade (opcional)"><Input maxLength={120} value={f.city} onChange={set('city')} autoComplete="address-level2" /></Field>
                <Field label="UF"><Select value={f.uf} onChange={set('uf')}><option value="">—</option>{UFS.map((u) => <option key={u}>{u}</option>)}</Select></Field>
              </div>
              <Field label="Nome completo do representante"><Input required maxLength={160} value={f.repName} onChange={set('repName')} autoComplete="name" /></Field>
              <Field label="Cargo"><Input required maxLength={120} value={f.repRole} onChange={set('repRole')} /></Field>
              <Field label="E-mail"><Input required type="email" maxLength={200} value={f.repEmail} onChange={set('repEmail')} autoComplete="email" /></Field>
              <Field label="Celular com DDD (opcional)"><Input type="tel" inputMode="tel" value={f.repPhone} onChange={set('repPhone', maskPhone)} autoComplete="tel" /></Field>
            </div>
            <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" value={f.website} onChange={set('website')} />
            <p className="text-xs text-muted">Usamos estes dados para responder ao pedido e preparar a contratação, conforme a <a href="/privacidade" onClick={onLink} className="underline">política de privacidade</a>.</p>
          </Step>

          <Step n={3} title="Contrato com os seus dados">
            {!legal ? <Spinner /> : !legal.doc ? <Alert tone="warning">Contrato indisponível no momento.</Alert> : <>
              <Alert>Contrato oficial versão {legal.doc.version}. Os campos destacados são preenchidos com os seus dados; os que faltarem (CPF do síndico, endereço completo, datas) entram automaticamente na contratação, e o contrato é assinado pelas duas partes na Autentique.</Alert>
              <div className="flex flex-wrap gap-2 print:hidden">
                {toc.slice(0, 8).map((h) => <a key={h.id} href={`#${h.id}`} className="text-xs rounded-full bg-surface-2 px-3 py-1 hover:underline">{h.text}</a>)}
              </div>
              <div tabIndex={0} aria-label="Contrato preenchido" className="max-h-[65vh] overflow-y-auto rounded-xl border border-line bg-bg p-4 sm:p-6 print:max-h-none print:overflow-visible print:border-0">
                <Markdown md={filled} />
              </div>
              <p className="text-xs text-muted">Versão {legal.doc.version}. Os dados da etapa 2 aparecem no texto apenas nesta tela.</p>
            </>}
          </Step>

          <Step n={4} title="Aceite e envio">
            {done ? (
              <div className="space-y-4">
                <Alert tone="success">Pedido <strong>{done.protocol}</strong> recebido: {done.plan}, {CYCLE_LABEL[done.cycle].toLowerCase()}, {brl(done.amount_cents)} por ciclo. Entraremos em contato pelo e-mail informado.</Alert>
                <p className="text-sm">Próximo passo: crie a conta do condomínio e ative o mês grátis. Dentro do sistema, o contrato é preenchido com os dados do condomínio e assinado eletronicamente pelas duas partes na Autentique; o PDF assinado fica disponível no painel.</p>
                <div className="flex flex-wrap gap-2 print:hidden">
                  <Button onClick={startTrial}>Ativar o mês grátis com este plano</Button>
                  {SALES_WHATSAPP && <a href={`https://wa.me/${SALES_WHATSAPP}?text=${encodeURIComponent(summary())}`} target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl px-4 min-h-11 border border-line font-semibold"><MessageCircle className="w-4 h-4" aria-hidden />Enviar resumo pelo WhatsApp</a>}
                  <Button variant="secondary" type="button" onClick={() => print()}><Printer className="w-4 h-4" aria-hidden />Imprimir ou salvar em PDF</Button>
                </div>
              </div>
            ) : <>
              <label className="flex gap-3 items-start">
                <input type="checkbox" className="mt-1 w-5 h-5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span className="text-sm">Li o contrato acima e concordo com os termos para seguir com a contratação do plano {plan?.name || ''} ({CYCLE_LABEL[cycle].toLowerCase()}).</span>
              </label>
              <Alert><strong>{KIOSK.name} (acesso piloto):</strong> {KIOSK.included} {KIOSK.requirement} {KIOSK.pilot} <a href={KIOSK.href} onClick={onLink} className="underline">{KIOSK.cta}</a>.</Alert>
              <p className="text-xs text-muted">Este envio é um <strong>pedido de contratação</strong>, não substitui o contrato assinado dentro do sistema (preenchido com os dados do condomínio e assinado pelas duas partes na Autentique). Nenhuma cobrança é feita agora; o mês grátis vem primeiro.</p>
              {error && <Alert tone="danger">{error}</Alert>}
              <div className="flex flex-wrap gap-2 print:hidden">
                <Button type="submit" loading={busy} disabled={!ready}><FileText className="w-4 h-4" aria-hidden />Enviar pedido de contratação</Button>
                <Button type="button" variant="secondary" onClick={() => print()}><Printer className="w-4 h-4" aria-hidden />Imprimir contrato</Button>
                <Button type="button" variant="ghost" onClick={startTrial}>Prefiro começar pelo mês grátis</Button>
              </div>
              {!ready && <p className="text-xs text-muted" role="status">Para enviar: escolha o plano, preencha condomínio, representante e e-mail e marque a concordância.</p>}
            </>}
          </Step>
        </form>
      </main>
    </div>
  );
}
