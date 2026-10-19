/**
 * POST /api/jobs/tick   Authorization: Bearer <CRON_SECRET>
 * Job confiável (Vercel Cron ou agendador externo). Idempotente e seguro em paralelo:
 *  1. ciclo comercial (lembretes D-7/D-3/término, pedido pós-teste, renovação, past_due)
 *  2. reprocessa eventos de pagamento pendentes (com consulta ao provedor)
 *  3. envia a fila de notificações (outbox) com retry/backoff
 */
import { handler, json, safeEqual, HttpError } from '../_lib/http.js';
import { env, appUrl } from '../_lib/env.js';
import { serviceClient } from '../_lib/supabase.js';
import { verifyAndApply } from '../_lib/payments.js';
import { render, emailHtml } from '../_lib/templates.js';
import { sendEmail, sendWhatsApp, sendPush, SendResult } from '../_lib/channels.js';

async function run(request: Request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(token, env('CRON_SECRET'))) throw new HttpError(401, 'Não autorizado.');
  const svc = serviceClient();
  const base = appUrl();
  const report: any = {};

  const { data: billing, error: be } = await svc.rpc('billing_tick');
  if (be) throw new Error(be.message);
  report.billing = billing;

  const { data: events } = await svc.rpc('claim_payment_events', { p_limit: 20 });
  report.payments = 0;
  for (const ev of events || []) {
    const p = ev.payload || {};
    try {
      const r = await verifyAndApply(svc, { orderNsu: p.order_nsu, transactionNsu: p.transaction_nsu, slug: p.invoice_slug, receiptUrl: p.receipt_url });
      const st = r.result === 'activated' || r.result === 'duplicate_ignored' ? 'processed' : r.result === 'review' ? 'review' : 'error';
      await svc.rpc('finish_payment_event', { p_event: ev.id, p_status: st, p_error: st === 'error' ? r.result : null });
      report.payments++;
    } catch (e: any) {
      await svc.rpc('finish_payment_event', { p_event: ev.id, p_status: 'error', p_error: String(e?.message || e) });
    }
  }

  const { data: jobs } = await svc.rpc('claim_notification_jobs', { p_limit: 50 });
  const counts: Record<string, number> = {};
  for (const job of jobs || []) {
    let res: SendResult;
    try {
      const { data: ctx } = await svc.rpc('notification_context', { p_job: job.id });
      const m: any = render(job.event, ctx, job.payload, base);
      if (job.channel === 'email') {
        res = await sendEmail(job.recipient, m.subject, emailHtml(ctx, m));
      } else if (job.channel === 'whatsapp') {
        const wa = ctx.whatsapp;
        if (!wa?.enabled || !wa.instance) res = { status: 'disabled', error: 'WhatsApp não conectado neste condomínio' };
        else {
          const { data: allowed } = await svc.rpc('consume_whatsapp', { p_tenant: job.tenant_id });
          res = allowed ? await sendWhatsApp(wa.instance, job.recipient, m.whatsapp) : { status: 'disabled', error: 'Franquia de WhatsApp esgotada' };
        }
      } else {
        const { data: subs } = await svc.from('push_subscriptions').select('id, endpoint, p256dh, auth')
          .eq('tenant_id', job.tenant_id).eq('user_id', job.recipient);
        if (!subs?.length) res = { status: 'disabled', error: 'Sem dispositivo inscrito' };
        else {
          const results = await Promise.all(subs.map(async (s) => {
            const r = await sendPush(s, m.push);
            if (r.gone) await svc.from('push_subscriptions').delete().eq('id', s.id);
            return r;
          }));
          res = results.find((r) => r.status === 'accepted') || results[0];
        }
      }
    } catch (e: any) {
      res = { status: 'failed', error: String(e?.message || e) };
    }
    await svc.rpc('complete_notification_job', { p_job: job.id, p_status: res.status, p_provider_ref: res.ref || null, p_error: res.error || null });
    counts[`${job.channel}:${res.status}`] = (counts[`${job.channel}:${res.status}`] || 0) + 1;
  }
  report.notifications = counts;
  return json(report);
}

export const POST = handler(run);
// Vercel Cron chama com GET e envia "Authorization: Bearer $CRON_SECRET".
export const GET = handler(run);
