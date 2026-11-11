// /contratar?plano=<code>&ciclo=<cycle>  ou  /contratar?proposta=<token>
// Aceite eletrônico do contrato pelo representante do condomínio. Preço, ciclo e limites
// vêm do servidor (contract_quote); o servidor recalcula tudo de novo no aceite.
// Aceite não é pagamento: o pagamento segue pelo fluxo existente de Assinatura.
import React, { useEffect, useState } from 'react';
import { api, rpc } from '../lib/api';
import { brl, CYCLE_LABEL, dateTime } from '../lib/format';
import { navigate, onLink, query } from '../lib/router';
import { useSession } from '../lib/session';
import { Markdown } from '../lib/legal';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';
import { KIOSK } from '../lib/kiosk-offer';
import { SignaturePanel } from '../components/SignaturePanel';

const LIMIT: Record<string, string> = { max_units: 'Unidades', max_concierges: 'Portarias', ocr_monthly: 'Leituras OCR por mês', whatsapp_monthly: 'Mensagens de WhatsApp por mês', storage_mb: 'Armazenamento (MB)' };

type Quote = {
  terms: { source: string; plan_name: string; plan_code: string; cycle: string; amount_cents: number; limits: Record<string, any>; trial_ends_at: string | null; valid_until?: string | null; price_kept?: boolean };
  document: { version: string; content_md: string; sha256: string; summary: string | null } | null;
  contractor: { name: string; document: string | null };
  subscription: { status: string; plan_code: string; cycle: string; trial_ends_at: string | null; current_period_end: string | null; cancel_at_period_end: boolean } | null;
  active: { id: string; document_version: string; accepted_at: string } | null;
};

/** Prévia na tela com os dados digitados (o texto oficial é preenchido de novo no servidor, com os dados do banco). */
function previewContract(md: string, f: Record<string, string>, t: Quote['terms']) {
  const v: Record<string, string> = {
    CONDOMINIO_NOME: f.contractorName, CONDOMINIO_CNPJ: f.contractorDocument, CONDOMINIO_ENDERECO: f.contractorAddress,
    SINDICO_NOME: f.representativeName, SINDICO_CPF: f.representativeCpf, SINDICO_EMAIL: f.representativeEmail, SINDICO_TELEFONE: f.representativePhone,
    PLANO_NOME: t.plan_name, PLANO_VALOR_MENSAL: (t.amount_cents / 100 / ({ monthly: 1, quarterly: 3, yearly: 12 } as Record<string, number>)[t.cycle]).toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
  };
  return md.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (v[k]?.trim() ? `**${v[k].trim()}**` : m));
}

export default function ContratarPage() {
  const { ctx } = useSession();
  const plan = query('plano'); const cycle = query('ciclo') || 'monthly'; const proposal = query('proposta');
  const billing = (ctx?.tenants || []).filter((t) => t.role === 'admin' && t.permissions.includes('billing') && t.tenant_status === 'active');
  const [tenantId, setTenantId] = useState(billing[0]?.tenant_id || '');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const [agree, setAgree] = useState(false);
  const [form, setForm] = useState({ contractorName: '', contractorDocument: '', contractorAddress: '', representativeName: '', representativeCpf: '',
    representativeEmail: ctx?.email || '', representativePhone: '', representativeRole: 'Síndico(a)', representativeAuthority: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [code, setCode] = useState('');
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let on = true; setQuote(null); setError(null); setRead(false); setAgree(false);
    rpc<Quote>('contract_quote', { p_tenant: tenantId, p_plan_code: proposal ? null : plan, p_cycle: proposal ? null : cycle, p_proposal: proposal })
      .then((q) => { if (!on) return; setQuote(q); setForm((f) => ({ ...f, contractorName: f.contractorName || q.contractor.name, contractorDocument: f.contractorDocument || q.contractor.document || '' })); })
      .catch((e) => on && setError(e.message));
    return () => { on = false; };
  }, [tenantId, plan, cycle, proposal]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const tenant = billing.find((t) => t.tenant_id === tenantId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quote?.document || !agree) return;
    setBusy(true); setError(null);
    try {
      const r = await api('/api/billing/contract_accept', { tenantId, documentSha256: quote.document.sha256, accepted: agree,
        ...(proposal ? { proposal } : { plan, cycle }), ...form });
      setResult(r); setVerifyMsg(r.message);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setVerifyMsg(null);
    try {
      const r = await api('/api/billing/contract_verify', { acceptanceId: result.acceptanceId, code });
      setResult((x: any) => ({ ...x, status: r.status })); setVerifyMsg('E-mail confirmado. A cópia em PDF será enviada ao representante.');
    } catch (err: any) { setVerifyMsg(err.body?.error || err.message); } finally { setBusy(false); }
  };
  const newCode = async () => {
    setBusy(true);
    try { setVerifyMsg((await api('/api/billing/contract_code', { acceptanceId: result.acceptanceId })).message); }
    catch (err: any) { setVerifyMsg(err.message); } finally { setBusy(false); }
  };
  const openPdf = async () => {
    try { location.href = (await api('/api/billing/contract_pdf', { acceptanceId: result.acceptanceId })).url; }
    catch (err: any) { setVerifyMsg(err.message); }
  };

  // Aceite não muda a assinatura. Se o plano aceito difere do da assinatura, a troca é ação explícita
  // (mesma RPC da tela de Assinatura: no teste vale já; com período pago, no próximo ciclo).
  const applyPlan = async () => {
    setBusy(true);
    try {
      const r = await rpc('change_plan', { p_tenant: tenantId, p_plan_code: quote!.terms.plan_code, p_cycle: quote!.terms.cycle });
      setVerifyMsg(r.effective === 'now' ? 'Plano da assinatura atualizado.' : `Plano agendado para o próximo ciclo (${dateTime(r.effective_at)}).`);
      setQuote((q) => q && q.subscription ? { ...q, subscription: { ...q.subscription, plan_code: q.terms.plan_code, cycle: q.terms.cycle } } : q);
    } catch (err: any) { setVerifyMsg(err.message); } finally { setBusy(false); }
  };
  const t = quote?.terms;
  const planDiffers = !!quote?.subscription && !!t && t.source === 'catalog' && (quote.subscription.plan_code !== t.plan_code || quote.subscription.cycle !== t.cycle);
  const inTrial = !!quote?.subscription && quote.subscription.status === 'trialing' && !!t?.trial_ends_at && new Date(t.trial_ends_at) > new Date();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface"><div className="max-w-5xl mx-auto px-4 h-16 flex items-center"><PortariaPrimeLogo className="h-8 w-auto" /></div></header>
      <main className="max-w-5xl mx-auto px-4 py-8 space-y-5">
        <h1 className="text-2xl font-semibold">Contratar o Portaria Prime</h1>
        {billing.length === 0 ? <Alert tone="warning">Só administradores com permissão de faturamento podem contratar. Peça ao síndico que conceda a permissão ou <a href="/onboarding" onClick={onLink} className="underline">cadastre o condomínio</a> (mês grátis).</Alert> : <>
          {billing.length > 1 && <Field label="Condomínio"><Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} disabled={!!result}>{billing.map((b) => <option key={b.tenant_id} value={b.tenant_id}>{b.name}</option>)}</Select></Field>}
          {error && <Alert tone="danger">{error}</Alert>}
          {!quote && !error ? <Spinner /> : quote && !result && <>
            <Card className="space-y-2">
              <div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-lg">{t!.plan_name} · {CYCLE_LABEL[t!.cycle] || t!.cycle}</p>{t!.source === 'proposal' && <Badge tone="accent">Proposta comercial</Badge>}</div>
              <p><strong>{brl(t!.amount_cents)}</strong> por ciclo {(CYCLE_LABEL[t!.cycle] || '').toLowerCase()}, cobrado por link a cada ciclo. Sem débito automático.</p>
              <ul className="text-sm text-muted grid sm:grid-cols-2 gap-x-4">{Object.entries(t!.limits || {}).filter(([k]) => LIMIT[k]).map(([k, v]) => <li key={k}>{LIMIT[k]}: {String(v)}</li>)}</ul>
              {t!.price_kept && <p className="text-sm">Mesmo plano e ciclo da assinatura atual: o valor contratado é mantido, sem reajuste pela nova tabela.</p>}
              <p className="text-sm text-muted"><strong className="text-text">{KIOSK.feature}</strong> — {KIOSK.included} {KIOSK.requirement} {KIOSK.pilot}</p>
              {inTrial
                ? <Alert>O mês grátis segue até <strong>{dateTime(t!.trial_ends_at)}</strong>. Contratar agora <strong>não encurta o teste</strong> e não cobra nada: o primeiro link de pagamento só é gerado ao fim do teste. Pagar antes não é possível pelo sistema.</Alert>
                : <Alert>O aceite do contrato <strong>não é pagamento</strong>. Depois do aceite, você segue para o pagamento pelo link da InfinitePay; a assinatura só é ativada quando a InfinitePay confirmar o pagamento.</Alert>}
              <p className="text-sm text-muted">Cancelamento: pelo próprio sistema, a qualquer momento, sem falar com o comercial. O acesso continua até o fim do período já liberado; depois fica restrito a consulta e exportação. Atraso não apaga provas de entrega.</p>
              {quote.active && <Alert tone="warning">Este condomínio já tem contrato vigente (versão {quote.active.document_version}, aceito em {dateTime(quote.active.accepted_at)}). Um novo aceite será registrado como aditivo, ligado ao anterior.</Alert>}
            </Card>
            {!quote.document ? <Alert tone="warning">O contrato ainda não foi publicado pela Portaria Prime. A contratação eletrônica fica disponível após a publicação. <a href="/contrato" onClick={onLink} className="underline">Ler o modelo do contrato</a>.</Alert> : (
              <form onSubmit={submit} className="space-y-5">
                <Card className="space-y-2">
                  <p className="font-semibold">Contrato — versão {quote.document.version}</p>
                  {quote.document.summary && <p className="text-sm text-muted">{quote.document.summary}</p>}
                  <div tabIndex={0} aria-label="Texto completo do contrato" className="max-h-[60vh] overflow-y-auto rounded-xl border border-line p-4"
                    onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) setRead(true); }}>
                    <Markdown md={previewContract(quote.document.content_md, form, t!)} />
                  </div>
                  <p className="text-xs text-muted break-all">SHA-256 do texto exibido: {quote.document.sha256}</p>
                </Card>
                <Card className="grid sm:grid-cols-2 gap-4">
                  <p className="font-semibold sm:col-span-2">Contratante e representante</p>
                  <Field label="Nome do condomínio"><Input required maxLength={200} value={form.contractorName} onChange={set('contractorName')} /></Field>
                  <Field label="CNPJ do condomínio (ou CPF do responsável)"><Input required inputMode="numeric" value={form.contractorDocument} onChange={set('contractorDocument')} /></Field>
                  <div className="sm:col-span-2"><Field label="Endereço do condomínio" hint="Logradouro, número, bairro, cidade/UF e CEP."><Input required minLength={10} maxLength={300} autoComplete="street-address" value={form.contractorAddress} onChange={set('contractorAddress')} /></Field></div>
                  <Field label="Nome completo do síndico/representante"><Input required maxLength={160} autoComplete="name" value={form.representativeName} onChange={set('representativeName')} /></Field>
                  <Field label="CPF do síndico/representante"><Input required inputMode="numeric" value={form.representativeCpf} onChange={set('representativeCpf')} /></Field>
                  <Field label="E-mail do síndico" hint="Receberá o link de assinatura na Autentique e o contrato assinado."><Input required type="email" autoComplete="email" value={form.representativeEmail} onChange={set('representativeEmail')} /></Field>
                  <Field label="WhatsApp do síndico com DDD"><Input required type="tel" autoComplete="tel" value={form.representativePhone} onChange={set('representativePhone')} /></Field>
                  <Field label="Cargo"><Input required maxLength={120} value={form.representativeRole} onChange={set('representativeRole')} /></Field>
                  <Field label="Poderes para contratar" hint="Ex.: síndico eleito em assembleia de 10/03/2026; procuração de …"><Input required maxLength={300} value={form.representativeAuthority} onChange={set('representativeAuthority')} /></Field>
                </Card>
                <Card className="space-y-3">
                  {!read && <p className="text-sm text-muted">Role o contrato até o fim para habilitar o aceite.</p>}
                  <label className="flex gap-3 items-start">
                    <input type="checkbox" className="mt-1 w-5 h-5" checked={agree} disabled={!read} onChange={(e) => setAgree(e.target.checked)} />
                    <span className="text-sm">Li o contrato versão {quote.document.version}, declaro ter poderes para contratar em nome de {tenant?.name} e aceito as condições acima.</span>
                  </label>
                  <p className="text-xs text-muted">Ao continuar, o contrato é preenchido com estes dados e enviado para assinatura eletrônica das duas partes na Autentique. Registramos data e hora do servidor, sua conta, IP e navegador.</p>
                  <Button type="submit" loading={busy} disabled={!agree}>Aceitar e gerar contrato para assinatura</Button>
                </Card>
              </form>
            )}
          </>}
          {result && <Card className="space-y-3">
            <p className="font-semibold text-lg">Aceite registrado</p>
            <p className="text-sm">Registro {result.acceptanceId} · versão {result.documentVersion} · {dateTime(result.acceptedAt)} (horário do servidor)</p>
            <p className="text-xs text-muted break-all">SHA-256 do documento: {result.documentSha256}{result.pdfSha256 ? ` · SHA-256 do PDF: ${result.pdfSha256}` : ''}</p>
            {result.verification !== 'autentique' && <Badge tone={result.status === 'active' ? 'success' : 'warning'}>{result.status === 'active' ? 'Contrato vigente' : 'Aguardando confirmação do e-mail do representante'}</Badge>}
            {verifyMsg && <Alert tone={result.verification === 'unavailable' ? 'warning' : 'info'}>{verifyMsg}</Alert>}
            {result.verification === 'autentique' && <SignaturePanel acceptanceId={result.acceptanceId} tenantId={tenantId} />}
            {result.status === 'pending_verification' && result.verification !== 'unavailable' && result.verification !== 'autentique' && <div className="flex flex-wrap gap-2 items-end">
              <Field label="Código de 6 dígitos"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
              <Button onClick={verify} loading={busy} disabled={code.length !== 6}>Confirmar</Button>
              <Button variant="ghost" onClick={newCode} loading={busy}>Enviar novo código</Button>
            </div>}
            {planDiffers && <Alert tone="warning">A assinatura atual está em outro plano ou ciclo. O aceite não altera a assinatura; para cobrar conforme o plano aceito, confirme a troca.
              <div className="mt-2"><Button variant="secondary" onClick={applyPlan} loading={busy}>Aplicar {t!.plan_name} · {CYCLE_LABEL[t!.cycle]} à assinatura</Button></div></Alert>}
            {t?.source === 'proposal' && <Alert>Condições de proposta: a aplicação do valor negociado à cobrança é feita pela equipe comercial da Portaria Prime.</Alert>}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
              <Button variant="secondary" onClick={openPdf}>Baixar PDF do contrato</Button>
              {tenant && <Button onClick={() => navigate(`/c/${tenant.slug}/configuracoes?m=plano`)}>{inTrial ? 'Ver assinatura (pagamento ao fim do teste)' : 'Seguir para o pagamento'}</Button>}
            </div>
          </Card>}
        </>}
      </main>
    </div>
  );
}
