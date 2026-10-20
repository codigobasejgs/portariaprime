import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { api, rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { loadCatalog, PlanRow } from '../../lib/catalog';
import { brl, CYCLE_LABEL, CYCLE_MONTHS, dateTime } from '../../lib/format';
import { Alert, Badge, Button, Card, Field, Select, Spinner, useAction } from '../../components/ui';

const STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'accent' | 'neutral']> = {
  trialing: ['Mês grátis', 'accent'], active: ['Ativa', 'success'], pending_payment: ['Aguardando pagamento', 'warning'],
  past_due: ['Vencida', 'danger'], suspended: ['Suspensa', 'danger'], canceled: ['Cancelada', 'neutral'],
};

export function AssinaturaPage() {
  const t = useTenant();
  const ov = t.overview;
  const tz = t.tenant.timezone;
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [plan, setPlan] = useState(ov?.plan?.code);
  const [cycle, setCycle] = useState(ov?.cycle);
  const [payError, setPayError] = useState<string | null>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    loadCatalog().then(setPlans);
    supabase.from('billing_orders').select('id, status, amount_cents, cycle, created_at, paid_at, period_end, snapshot').eq('tenant_id', t.tenant.id)
      .order('created_at', { ascending: false }).limit(20).then(({ data }) => setOrders(data || []));
  }, [t.tenant.id]);

  if (!ov) return <Spinner />;
  const [label, tone] = STATUS[ov.status] || [ov.status, 'neutral'];
  const trialActive = ov.status === 'trialing' && new Date(ov.now) < new Date(ov.trial_ends_at);
  const selectable = (plans || []).filter((p) => !p.is_custom);
  const sel = selectable.find((p) => p.code === plan);
  const selPrice = sel?.prices.find((x) => x.cycle === cycle);

  const pay = () => run(async () => {
    setPayError(null);
    try {
      const r = await api('/api/billing/checkout', { tenantId: t.tenant.id });
      location.href = r.checkoutUrl; // domínio do provedor (link criado pelo servidor)
    } catch (e: any) {
      setPayError(e.message);
    }
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Assinatura</h1>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-lg">{ov.plan.name} · {CYCLE_LABEL[ov.cycle]}</p><Badge tone={tone}>{label}</Badge></div>
        {ov.status === 'trialing' && (
          <div className="text-sm space-y-1">
            <p>Mês grátis de <strong>{dateTime(ov.trial_started_at, tz)}</strong> até <strong>{dateTime(ov.trial_ends_at, tz)}</strong>.</p>
            <p>Depois do teste: <strong>{brl(ov.price_cents)}</strong> {ov.cycle === 'monthly' ? 'por mês' : `pelo ciclo ${CYCLE_LABEL[ov.cycle].toLowerCase()} (total; equivale a ${brl(Math.round(ov.price_cents / CYCLE_MONTHS[ov.cycle]))}/mês)`}.</p>
            <p className="text-muted">Nenhuma cobrança durante o teste. Ao final, o pagamento é feito por link (Pix ou cartão), sem débito automático.</p>
          </div>
        )}
        {ov.current_period_end && <p className="text-sm">Período pago até <strong>{dateTime(ov.current_period_end, tz)}</strong>.</p>}
        {ov.cancel_at_period_end && <Alert tone="warning">Cancelamento agendado: o acesso continua até {dateTime(ov.access_until, tz)} e nenhuma nova cobrança será gerada.</Alert>}
        {ov.commercial_state === 'grace' && <Alert tone="warning">Período de carência de {ov.grace_days} dias após o vencimento. Pague para evitar o bloqueio de novos recebimentos.</Alert>}
        {ov.commercial_state === 'restricted' && <Alert tone="danger">Acesso restrito: novos recebimentos e recursos pagos bloqueados. Dados, consultas, exportação e retirada de encomendas guardadas continuam disponíveis.</Alert>}
        {ov.next_plan && <p className="text-sm">Mudança agendada para o próximo ciclo: <strong>{ov.next_plan.name} · {CYCLE_LABEL[ov.next_plan.cycle]}</strong> (a partir de {dateTime(ov.current_period_end, tz)}).</p>}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Usage label="Unidades" used={ov.usage.units} max={ov.entitlements.max_units} />
          <Usage label="Portarias" used={ov.usage.concierges} max={ov.entitlements.max_concierges} />
          {ov.entitlements.feature_ocr && <Usage label="Leituras OCR (mês)" used={ov.usage.ocr} max={ov.entitlements.ocr_monthly} />}
          {ov.entitlements.feature_whatsapp && <Usage label="WhatsApp (mês)" used={ov.usage.whatsapp} max={ov.entitlements.whatsapp_monthly} />}
        </div>
        {!trialActive && ov.status !== 'canceled' && (
          <div className="space-y-2">
            <Button onClick={pay} loading={busy}>{ov.status === 'active' ? 'Renovar agora' : 'Pagar assinatura'}</Button>
            <p className="text-xs text-muted">Você será levado ao checkout seguro da InfinitePay. A assinatura é ativada só após a confirmação do pagamento pela InfinitePay.</p>
            {payError && <Alert tone="warning">{payError}</Alert>}
          </div>
        )}
        <div className="flex gap-2 pt-2 border-t border-line">
          {ov.cancel_at_period_end || ov.status === 'canceled'
            ? <Button variant="secondary" loading={busy} onClick={() => run(async () => { await rpc('reactivate_subscription', { p_tenant: t.tenant.id }); await t.reload(); }, 'Assinatura reativada.')}>Reativar</Button>
            : <Button variant="ghost" loading={busy} onClick={() => confirm('Cancelar a assinatura? O acesso continua até o fim do período já liberado.') && run(async () => { await rpc('cancel_subscription', { p_tenant: t.tenant.id }); await t.reload(); }, 'Cancelamento registrado.')}>Cancelar assinatura</Button>}
        </div>
      </Card>

      <Card className="space-y-3">
        <p className="font-semibold">Trocar de plano</p>
        <p className="text-sm text-muted">{trialActive ? 'Durante o teste, a troca vale na hora e o término do teste não muda.' : 'A troca vale a partir do próximo ciclo (sem cobrança proporcional). Nenhum dado é apagado.'}</p>
        {!plans ? <Spinner /> : (
          <div className="grid sm:grid-cols-3 gap-3 items-end">
            <Field label="Plano"><Select value={plan} onChange={(e) => setPlan(e.target.value)}>{selectable.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Ciclo"><Select value={cycle} onChange={(e) => setCycle(e.target.value)}>{sel?.prices.map((p) => <option key={p.cycle} value={p.cycle}>{CYCLE_LABEL[p.cycle]} — {brl(p.amount_cents)}</option>)}</Select></Field>
            <Button variant="secondary" disabled={!selPrice || (plan === ov.plan.code && cycle === ov.cycle)} loading={busy}
              onClick={() => run(async () => { await rpc('change_plan', { p_tenant: t.tenant.id, p_plan_code: plan, p_cycle: cycle }); await t.reload(); }, 'Plano atualizado.')}>Confirmar troca</Button>
          </div>
        )}
      </Card>

      <Card>
        <p className="font-semibold mb-2">Pedidos e pagamentos</p>
        {orders.length === 0 ? <p className="text-sm text-muted">Nenhum pedido ainda.</p> : (
          <ul className="divide-y divide-line text-sm">
            {orders.map((o) => (
              <li key={o.id} className="py-2 flex flex-wrap justify-between gap-2">
                <span>{o.snapshot?.plan_name} · {CYCLE_LABEL[o.cycle]} · {brl(o.amount_cents)} · {dateTime(o.created_at, tz)}</span>
                <Badge tone={o.status === 'paid' ? 'success' : o.status === 'review' ? 'danger' : 'warning'}>
                  {{ pending: 'Pendente', link_failed: 'Pendente', paid: `Pago — até ${dateTime(o.period_end, tz)}`, canceled: 'Cancelado', review: 'Em análise' }[o.status as string]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Usage({ label, used, max }: { label: string; used: number; max: number }) {
  return <div className="rounded-xl bg-surface-2 p-3"><p className="text-xs text-muted">{label}</p><p className="font-semibold">{used} / {max}</p></div>;
}

/** /checkout/retorno?pedido=… — nunca ativa nada pela URL; só consulta o servidor. */
export function CheckoutReturnPage() {
  const params = new URLSearchParams(location.search);
  const orderId = params.get('pedido');
  const [state, setState] = useState<'checking' | 'paid' | 'pending' | 'review' | 'error'>('checking');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let tries = 0;
    const tick = async () => {
      if (stop || !orderId) return setState('error');
      try {
        const r = await api('/api/billing/reconcile', { orderId, transactionNsu: params.get('transaction_nsu'), slug: params.get('slug') });
        if (r.status === 'paid') return setState('paid');
        if (r.status === 'review') { setMsg(r.message); return setState('review'); }
        setState('pending');
        setMsg(r.message || null);
      } catch (e: any) {
        setMsg(e.message);
        setState('error');
      }
      if (++tries < 12) setTimeout(tick, 10_000);
    };
    tick();
    return () => { stop = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-dvh grid place-items-center px-4">
      <Card className="max-w-md w-full space-y-3 text-center">
        {state === 'checking' && <Spinner label="Verificando pagamento…" />}
        {state === 'paid' && <Alert tone="success">Pagamento confirmado. Sua assinatura está ativa.</Alert>}
        {state === 'pending' && <Alert tone="info">Pagamento ainda não confirmado pela InfinitePay. Esta página verifica de novo automaticamente.{msg ? ` ${msg}` : ''}</Alert>}
        {state === 'review' && <Alert tone="warning">{msg}</Alert>}
        {state === 'error' && <Alert tone="danger">Não foi possível verificar agora. {msg} Você pode voltar à área de assinatura e tentar de novo.</Alert>}
        <a href="/app" className="text-secondary underline text-sm">Voltar ao sistema</a>
      </Card>
    </div>
  );
}
