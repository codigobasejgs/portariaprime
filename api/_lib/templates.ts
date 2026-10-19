/**
 * Templates de mensagens. Todo texto variável é escapado; nada de HTML vindo do
 * navegador. Marca do condomínio no conteúdo, assinatura Portaria Prime discreta.
 */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// WhatsApp usa *negrito*; remove marcadores para o dado não alterar a formatação.
const wa = (s: unknown) => String(s ?? '').replace(/[*_~`]/g, '').slice(0, 120);

export interface MessageCtx {
  tenant_name: string;
  tenant_slug: string;
  timezone: string;
  color_primary?: string | null;
  package?: {
    carrier?: string; tracking_code?: string | null; received_at?: string; picked_up_at?: string | null;
    picked_up_by?: string | null; storage_code?: string | null; unit?: string; protocol?: string | null;
  } | null;
}

const fmt = (iso: string | null | undefined, tz: string) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '';
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const CYCLE: Record<string, string> = { monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };

export function render(event: string, ctx: MessageCtx, payload: any, appUrl: string) {
  const p = ctx.package || {};
  const link = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/morador`;
  const billingLink = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/assinatura`;
  switch (event) {
    case 'package_received':
      return {
        subject: `Encomenda na portaria — ${ctx.tenant_name}`,
        push: { title: 'Nova encomenda na portaria', body: `${p.carrier || 'Encomenda'} aguardando retirada.`, url: link },
        whatsapp:
          `*${wa(ctx.tenant_name)}*\nChegou uma encomenda para a sua unidade.\n\n` +
          `Transportadora: ${wa(p.carrier)}\n` + (p.tracking_code ? `Rastreio: ${wa(p.tracking_code)}\n` : '') +
          `Recebida em: ${fmt(p.received_at, ctx.timezone)}\n\nAbra o app para ver o QR Code de retirada:\n${link}`,
        lines: [
          ['Unidade', p.unit], ['Transportadora', p.carrier], ['Rastreio', p.tracking_code],
          ['Recebida em', fmt(p.received_at, ctx.timezone)],
        ],
        cta: ['Ver QR Code de retirada', link],
        intro: 'Uma encomenda chegou para a sua unidade e está guardada na portaria.',
      };
    case 'package_picked_up':
      return {
        subject: `Encomenda retirada — ${ctx.tenant_name}`,
        push: { title: 'Encomenda retirada', body: 'O comprovante está disponível no app.', url: link },
        whatsapp:
          `*${wa(ctx.tenant_name)}*\nEncomenda retirada por ${wa(p.picked_up_by)} em ${fmt(p.picked_up_at, ctx.timezone)}.\n` +
          (p.protocol ? `Protocolo: ${wa(p.protocol)}\n` : '') + `Comprovante: ${link}`,
        lines: [['Unidade', p.unit], ['Retirada por', p.picked_up_by], ['Data', fmt(p.picked_up_at, ctx.timezone)], ['Protocolo', p.protocol]],
        cta: ['Ver comprovante', link],
        intro: 'Uma encomenda da sua unidade foi retirada na portaria.',
      };
    case 'trial_reminder': {
      const when = fmt(payload.trial_ends_at, ctx.timezone);
      const after = `${brl(payload.amount_cents)} (${CYCLE[payload.cycle] || payload.cycle})`;
      const intro = payload.kind === 'trial_end'
        ? `O mês grátis do ${ctx.tenant_name} terminou em ${when}. Para continuar, pague a assinatura: ${after}.`
        : `O mês grátis do ${ctx.tenant_name} termina em ${when}. Depois disso, o valor será ${after}, pago por link — sem débito automático.`;
      return { subject: 'Seu mês grátis da Portaria Prime', intro, lines: [], cta: ['Gerenciar assinatura', billingLink] };
    }
    case 'billing_order':
      return {
        subject: 'Pagamento da assinatura disponível',
        intro: `A cobrança de ${brl(payload.amount_cents)} (plano ${payload.plan_name}, ${CYCLE[payload.cycle] || payload.cycle}) está disponível.`,
        lines: [], cta: ['Pagar assinatura', billingLink],
      };
    case 'billing_paid':
      return {
        subject: 'Pagamento confirmado — Portaria Prime',
        intro: `Recebemos o pagamento de ${brl(payload.amount_cents)}. Assinatura válida até ${fmt(payload.period_end, ctx.timezone)}.`,
        lines: [], cta: ['Ver assinatura', billingLink],
      };
    default:
      throw new Error(`Evento sem template: ${event}`);
  }
}

export function emailHtml(ctx: MessageCtx, m: { intro: string; lines: any[][]; cta: string[] }) {
  const color = /^#[0-9A-Fa-f]{6}$/.test(ctx.color_primary || '') ? ctx.color_primary : '#101F30';
  const rows = m.lines.filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#526174;font-size:13px">${esc(k)}</td><td style="padding:6px 0;color:#18283A;font-size:14px;font-weight:600;text-align:right">${esc(v)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F7F5F0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${color};padding:20px 24px;color:#fff;font-size:18px;font-weight:700">${esc(ctx.tenant_name)}</td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 16px;color:#18283A;font-size:15px;line-height:1.5">${esc(m.intro)}</p>
${rows ? `<table role="presentation" width="100%">${rows}</table>` : ''}
<p style="margin:24px 0 0"><a href="${esc(m.cta[1])}" style="display:inline-block;background:#101F30;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(m.cta[0])}</a></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;color:#526174;font-size:11px">Tecnologia Portaria Prime · Cada encomenda. Tudo sob controle.</td></tr>
</table></td></tr></table></body></html>`;
}
