import React, { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { rpc } from '../lib/api';
import { loadCatalog, featureList, PlanRow } from '../lib/catalog';
import { brl, CYCLE_LABEL, dateTime } from '../lib/format';
import { navigate, query } from '../lib/router';
import { useSession } from '../lib/session';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';

const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

const TIMEZONES = ['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Porto_Velho', 'America/Rio_Branco', 'America/Noronha'];

/** Cadastro do condomínio + escolha de plano + ativação do mês grátis (servidor). */
export function OnboardingPage() {
  const { ctx, refresh } = useSession();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [doc, setDoc] = useState('');
  const [phone, setPhone] = useState('');
  const [tz, setTz] = useState('America/Sao_Paulo');
  const [plan, setPlan] = useState(query('plano') || 'profissional');
  const [cycle, setCycle] = useState<'monthly' | 'quarterly' | 'yearly'>((query('ciclo') as any) || 'monthly');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mesmo request id em retries/duplo clique: o servidor devolve o mesmo condomínio.
  const [requestId] = useState(() => {
    try {
      const k = sessionStorage.getItem('pp_provision_req') || crypto.randomUUID();
      sessionStorage.setItem('pp_provision_req', k);
      return k;
    } catch { return crypto.randomUUID(); }
  });

  useEffect(() => { loadCatalog().then(setPlans).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (!slugTouched) setSlug(slugify(name)); }, [name, slugTouched]);

  const selectable = useMemo(() => (plans || []).filter((p) => !p.is_custom && p.prices.length), [plans]);
  const chosen = selectable.find((p) => p.code === plan) || selectable[0];
  const price = chosen?.prices.find((p) => p.cycle === cycle);
  const trialEnd = useMemo(() => {
    const d = new Date();
    const t = new Date(d);
    t.setMonth(d.getMonth() + 1);
    if (t.getDate() !== d.getDate()) t.setDate(0); // 31/01 -> último dia de fevereiro
    return t;
  }, []);

  if (ctx && !ctx.email_verified) {
    return <Shell><Alert tone="warning">Confirme seu e-mail pelo link enviado e entre novamente para cadastrar o condomínio.</Alert></Shell>;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen || !price) return;
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<{ slug: string }>('provision_tenant', {
        p_request_id: requestId, p_name: name.trim(), p_slug: slug, p_document: doc, p_timezone: tz,
        p_plan_code: chosen.code, p_cycle: cycle, p_contact_phone: phone || null,
      });
      try { sessionStorage.removeItem('pp_provision_req'); } catch { /* ok */ }
      await refresh();
      navigate(`/c/${r.slug}/configuracoes?inicio=1`, true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="text-2xl font-semibold">Cadastre seu condomínio</h1>
      <p className="text-muted mt-1">Primeiro mês grátis. Sem cartão para começar. Escolha o plano que valerá depois do teste.</p>
      {!plans ? <Spinner /> : (
        <form onSubmit={submit} className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
          <Card className="space-y-4">
            <Field label="Nome do condomínio"><Input required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
            <Field label="Endereço no sistema" hint={`Seu condomínio ficará em ${location.host}/c/${slug || '…'}`}>
              <Input required pattern="[a-z0-9][a-z0-9-]{1,46}[a-z0-9]" value={slug}
                onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} />
            </Field>
            <Field label="CNPJ do condomínio (ou CPF do responsável)" hint="Usado para garantir um mês grátis por condomínio.">
              <Input required inputMode="numeric" value={doc} onChange={(e) => setDoc(e.target.value)} />
            </Field>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Telefone de contato (opcional)"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              <Field label="Fuso horário"><Select value={tz} onChange={(e) => setTz(e.target.value)}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            </div>
          </Card>
          <div className="space-y-4">
            <Card className="space-y-3">
              <p className="font-semibold">Plano após o teste</p>
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Ciclo">
                {(['monthly', 'quarterly', 'yearly'] as const).map((c) => (
                  <button type="button" key={c} role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)}
                    className={`min-h-10 rounded-lg text-sm font-medium ${cycle === c ? 'bg-surface shadow text-text' : 'text-muted'}`}>{CYCLE_LABEL[c]}</button>
                ))}
              </div>
              {selectable.map((p) => {
                const pr = p.prices.find((x) => x.cycle === cycle);
                return (
                  <label key={p.code} className={`flex gap-3 rounded-xl border p-3 cursor-pointer ${chosen?.code === p.code ? 'border-secondary ring-1 ring-secondary' : 'border-line'}`}>
                    <input type="radio" name="plan" className="mt-1" checked={chosen?.code === p.code} onChange={() => setPlan(p.code)} />
                    <span className="flex-1">
                      <span className="flex justify-between font-semibold"><span>{p.name}</span><span>{pr ? brl(pr.amount_cents) : '—'}</span></span>
                      <span className="block text-xs text-muted">{p.ent ? `Até ${p.ent.max_units} unidades · ${p.ent.max_concierges} portaria(s)` : ''}{cycle !== 'monthly' && pr ? ` · total do ciclo ${CYCLE_LABEL[cycle].toLowerCase()}` : ''}</span>
                    </span>
                  </label>
                );
              })}
            </Card>
            {chosen && price && (
              <Card className="space-y-2 text-sm">
                <p className="font-semibold">Primeiro mês grátis; depois {brl(price.amount_cents)} por ciclo {CYCLE_LABEL[cycle].toLowerCase()}.</p>
                <p className="text-muted">Teste estimado até <strong>{dateTime(trialEnd.toISOString())}</strong> (a data exata é definida pelo servidor ao ativar).</p>
                <p className="text-muted">Sem cobrança durante o teste. Ao final, geramos o link de pagamento — sem débito automático. Cancele quando quiser em Assinatura.</p>
                <ul className="pt-2 space-y-1">{featureList(chosen).map((f) => <li key={f} className="flex gap-2"><Check className="w-4 h-4 text-success shrink-0 mt-0.5" />{f}</li>)}</ul>
              </Card>
            )}
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" loading={busy} className="w-full" disabled={!chosen || !price}>Ativar mês grátis</Button>
          </div>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface"><div className="max-w-6xl mx-auto px-4 h-16 flex items-center"><PortariaPrimeLogo className="h-8 w-auto" /></div></header>
      <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
