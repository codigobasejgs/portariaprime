/**
 * Templates de mensagens. Todo texto variável é escapado; nada de HTML vindo do
 * navegador. Marca do condomínio no conteúdo, assinatura Portaria Prime discreta.
 */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// WhatsApp usa *negrito*; remove marcadores para o dado não alterar a formatação.
const wa = (s: unknown) => String(s ?? '').replace(/[*_~`]/g, '').slice(0, 120);

export interface MessageCtx {
  trial_ends_at?: string | null;
  admin_name?: string | null;
  tenant_name: string;
  tenant_slug: string;
  timezone: string;
  color_primary?: string | null;
  /** URL pública absoluta do logo (montada no servidor a partir do Storage público do condomínio). */
  logo_url?: string | null;
  resident?: { name?: string | null; unit?: string | null; reason?: string | null } | null;
  package?: {
    carrier?: string; tracking_code?: string | null; received_at?: string; picked_up_at?: string | null;
    picked_up_by?: string | null; storage_code?: string | null; unit?: string; protocol?: string | null; id?: string; pdf_path?: string | null;
  } | null;
  support?: { ticket_id?: string; protocol?: string } | null;
  contract?: {
    id?: string; document_version?: string; document_sha256?: string; accepted_at?: string; plan_name?: string; cycle?: string;
    amount_cents?: number; representative_name?: string; pdf_path?: string | null; pdf_sha256?: string | null;
  } | null;
}

const fmt = (iso: string | null | undefined, tz: string) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '';
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const CYCLE: Record<string, string> = { monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };

export function render(event: string, ctx: MessageCtx, payload: any, appUrl: string) {
  const p = ctx.package || {};
  const home = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/inicio`;
  // Chegada abre o detalhe atual da encomenda (se já foi retirada, mostra o comprovante, nunca QR inválido).
  const link = p.id ? `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/encomenda?p=${encodeURIComponent(p.id)}` : home;
  // Link estável: abre após login, só para quem tem vínculo com a unidade (nada público).
  const receiptLink = p.id ? `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/comprovante?p=${encodeURIComponent(p.id)}` : home;
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
    case 'package_reminder':
      // Push curto e sem dado pessoal (aparece na tela bloqueada).
      return {
        subject: `Lembrete: encomenda aguardando retirada — ${ctx.tenant_name}`,
        push: { title: 'Encomenda aguardando retirada', body: 'Toque para ver o QR Code de retirada.', url: link },
        whatsapp:
          `*${wa(ctx.tenant_name)}*\nLembrete: há uma encomenda aguardando retirada na portaria desde ${fmt(p.received_at, ctx.timezone)}.\n\n` +
          `Abra o app para ver o QR Code de retirada:\n${link}`,
        lines: [['Unidade', p.unit], ['Transportadora', p.carrier], ['Recebida em', fmt(p.received_at, ctx.timezone)]],
        cta: ['Ver QR Code de retirada', link],
        intro: 'Lembrete: uma encomenda da sua unidade continua aguardando retirada na portaria.',
      };
    case 'package_picked_up':
      return {
        subject: `${ctx.tenant_name} — Comprovante de entrega — Unidade ${p.unit || ''}`,
        push: { title: 'Encomenda retirada', body: 'O comprovante está disponível no app.', url: receiptLink },
        whatsapp:
          `*${wa(ctx.tenant_name)}*\nEncomenda retirada por ${wa(p.picked_up_by)} em ${fmt(p.picked_up_at, ctx.timezone)}.\n` +
          (p.protocol ? `Protocolo: ${wa(p.protocol)}\n` : '') + `Comprovante (requer login): ${receiptLink}`,
        lines: [['Unidade', p.unit], ['Retirada por', p.picked_up_by], ['Data', fmt(p.picked_up_at, ctx.timezone)], ['Protocolo', p.protocol]],
        cta: ['Ver comprovante', receiptLink],
        intro: 'Uma encomenda da sua unidade foi retirada na portaria. O comprovante em PDF segue anexo.',
      };
    case 'portal_welcome': {
      const portal = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}`;
      const until = ctx.trial_ends_at ? ` Seu período de teste termina em ${fmt(ctx.trial_ends_at, ctx.timezone).split(',')[0]}.` : '';
      const intro = `Olá, ${ctx.admin_name || 'administrador(a)'}. O portal do ${ctx.tenant_name} está disponível: ${portal}. Acesse Administração para concluir as configurações. Você também pode compartilhar esse endereço com os moradores para que solicitem cadastro.${until}`;
      return {
        subject: `Portal do ${ctx.tenant_name} está no ar`,
        whatsapp: `*${wa(ctx.tenant_name)}*
${wa(intro).slice(0, 600)}

Equipe Portaria Prime`,
        intro, lines: [], cta: ['Abrir o portal', portal],
      };
    }
    case 'access_request': {
      // Ao síndico: só o necessário para revisar (nome e unidade); contato completo fica na fila autenticada.
      const r = ctx.resident || {};
      const queue = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/pessoas`;
      return {
        subject: `Nova solicitação de cadastro — ${ctx.tenant_name}`,
        push: { title: 'Nova solicitação de cadastro', body: 'Um morador pediu acesso. Toque para revisar.', url: queue },
        intro: 'Um morador enviou o cadastro pelo portal e aguarda a sua aprovação.',
        lines: [['Morador', r.name], ['Unidade informada', r.unit]], cta: ['Revisar solicitações', queue],
      };
    }
    case 'access_received': {
      const r = ctx.resident || {};
      const portal = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}`;
      return {
        // Marca do condomínio do morador (multi-tenant); Portaria Prime só no rodapé discreto.
        subject: `Recebemos seu cadastro — ${ctx.tenant_name}`,
        intro: `Olá, ${r.name || 'morador(a)'}. Recebemos sua solicitação de cadastro no ${ctx.tenant_name}. Sua solicitação foi encaminhada para análise da administração. Assim que seu cadastro for aprovado, você receberá uma confirmação com o link de acesso ao aplicativo do condomínio.`,
        whatsapp: `Olá, ${wa(r.name || 'morador(a)')}!\n\nRecebemos seu cadastro no *${wa(ctx.tenant_name)}*.\n\nSua solicitação está aguardando aprovação da administração.\n\nVocê será informado quando seu acesso estiver liberado.`,
        lines: [['Condomínio', ctx.tenant_name], ['Unidade informada', r.unit], ['Situação', 'Aguardando aprovação']],
        cta: ['Acompanhar minha solicitação', `${portal}/solicitar`],
      };
    }
    case 'access_decision': {
      // Aprovado: confirmação e boas-vindas na MESMA mensagem por canal (sem duas mensagens seguidas).
      const ok = !!payload?.approved;
      const r = ctx.resident || {};
      const portal = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}`;
      const name = r.name || 'morador(a)';
      return ok ? {
        subject: `Bem-vindo ao ${ctx.tenant_name}!`,
        intro: `Olá, ${name}. Seu cadastro no ${ctx.tenant_name} foi aprovado! Agora você pode acessar o aplicativo do condomínio para acompanhar suas encomendas e correspondências. Utilize seu e-mail e a senha cadastrada.`,
        whatsapp: `Olá, ${wa(name)}! 👋\n\nSeja bem-vindo ao *${wa(ctx.tenant_name)}*!\n\nSeu cadastro foi aprovado.\n\nVocê já pode acessar o aplicativo e acompanhar suas encomendas.\n\n📱 Acesse: ${portal}\n\nEntre com seu e-mail e senha cadastrados.`,
        lines: [['Condomínio', ctx.tenant_name], ['Unidade', r.unit]], cta: ['Acessar o aplicativo', portal],
      } : {
        subject: `Cadastro não aprovado — ${ctx.tenant_name}`,
        intro: `Olá, ${name}. Sua solicitação de cadastro no ${ctx.tenant_name} não foi aprovada. Se houver algum dado incorreto (por exemplo, bloco ou unidade), você pode enviar o cadastro novamente pelo portal. Para esclarecimentos, procure a administração ou a portaria do condomínio.`,
        whatsapp: `Olá, ${wa(name)}.\n\nSua solicitação de cadastro no *${wa(ctx.tenant_name)}* não foi aprovada.\n\nSe algum dado estiver incorreto, envie o cadastro novamente pelo portal: ${portal}\n\nDúvidas: procure a administração do condomínio.`,
        lines: [['Motivo informado', r.reason]], cta: ['Abrir o portal', portal],
      };
    }
    case 'ops_alert':
      return {
        subject: `Alerta — ${ctx.tenant_name}`,
        push: { title: 'Alerta da portaria', body: 'Há um alerta operacional. Toque para ver.', url: `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/configuracoes` },
        intro: 'Há um alerta operacional no condomínio.', lines: [], cta: ['Abrir configurações', `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/configuracoes`],
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
    case 'support_reply': {
      // Sem conteúdo da conversa: só protocolo e link autenticado para o chamado.
      const protocol = /^SUP-\d{4}-\d{6,}$/.test(ctx.support?.protocol || '') ? ctx.support!.protocol! : '';
      const ticket = /^[0-9a-f-]{36}$/i.test(ctx.support?.ticket_id || '') ? `?chamado=${ctx.support!.ticket_id}` : '';
      const url = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/suporte${ticket}`;
      return {
        subject: `Resposta do suporte${protocol ? ` — ${protocol}` : ''}`,
        push: { title: 'Resposta do suporte', body: `Seu chamado ${protocol} tem uma nova resposta.`.replace('  ', ' '), url },
        intro: `A equipe da Portaria Prime respondeu ao seu chamado${protocol ? ` ${protocol}` : ''}. Abra o app para ler a resposta. Nunca pedimos sua senha.`,
        lines: [['Protocolo', protocol]], cta: ['Ver chamado', url],
      };
    }
    case 'quote_sent': {
      // Token no fragmento (#): não vai para logs de servidor nem para o Referer.
      const q = (ctx as any).quote || {};
      const url = `${appUrl}/proposta#${encodeURIComponent(String(payload.token || ''))}`;
      return {
        subject: `Sua proposta Portaria Prime — ${payload.protocol}`,
        intro: `Olá, ${q.contact_name || ''}. Preparamos a proposta para ${q.org_name || 'o seu condomínio'}: plano ${payload.plan_name}, `
          + `${brl(payload.amount_cents)} por ciclo ${CYCLE[payload.cycle] || payload.cycle}, válida até ${fmt(payload.valid_until, ctx.timezone).split(',')[0]}. `
          + 'Proposta sujeita às condições descritas no link.',
        lines: [['Protocolo', payload.protocol], ['Solicitação', q.protocol]],
        cta: ['Ver proposta', url],
      };
    }
    case 'contract_copy': {
      const c = ctx.contract || {};
      const when = fmt(c.accepted_at, ctx.timezone);
      return {
        subject: `Cópia do contrato aceito — Portaria Prime — ${ctx.tenant_name}`,
        whatsapp: `*Portaria Prime*\nCópia do contrato aceito por ${wa(ctx.tenant_name)} em ${when} (versão ${wa(c.document_version)}).\nO PDF está disponível em Configurações › Plano e assinatura: ${billingLink}`,
        intro: `Segue em anexo a cópia do contrato aceito eletronicamente para ${ctx.tenant_name}. O aceite não é pagamento: a cobrança segue por link a cada ciclo.`,
        lines: [['Versão do contrato', c.document_version], ['Aceito em', when],
          ['Plano', c.plan_name ? `${c.plan_name} · ${CYCLE[c.cycle || ''] || c.cycle || ''}` : null],
          ['Valor por ciclo', c.amount_cents ? brl(c.amount_cents) : null], ['SHA-256 do documento', c.document_sha256]],
        cta: ['Ver plano e assinatura', billingLink],
      };
    }
    default:
      throw new Error(`Evento sem template: ${event}`);
  }
}

/** Cor de texto legível sobre a cor do condomínio (contraste WCAG); cor inválida vira o padrão. */
export function headerColors(hex?: string | null) {
  const bg = /^#[0-9A-Fa-f]{6}$/.test(hex || '') ? hex! : '#101F30';
  const c = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return { bg, fg: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.4 ? '#101F30' : '#FFFFFF' };
}

/** Versão em texto simples (clientes sem HTML, leitores de tela, filtros de spam). */
export function emailText(ctx: MessageCtx, m: { intro: string; lines: any[][]; cta: string[] }) {
  const rows = m.lines.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  return [ctx.tenant_name, '', m.intro, ...(rows.length ? ['', ...rows] : []), '', `${m.cta[0]}: ${m.cta[1]}`, '', '—', 'Tecnologia Portaria Prime · Cada encomenda. Tudo sob controle.'].join('\n');
}

export function emailHtml(ctx: MessageCtx, m: { intro: string; lines: any[][]; cta: string[] }) {
  const { bg: color, fg } = headerColors(ctx.color_primary);
  // Logo só se a URL for HTTPS (vem do Storage público, montada no servidor); senão o nome basta.
  const logo = /^https:\/\/[^\s"'<>]+$/.test(ctx.logo_url || '')
    ? `<img src="${esc(ctx.logo_url)}" width="44" height="44" alt="" style="display:inline-block;vertical-align:middle;width:44px;height:44px;border-radius:8px;background:#fff;object-fit:contain;margin-right:12px">` : '';
  const rows = m.lines.filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#526174;font-size:13px">${esc(k)}</td><td style="padding:6px 0;color:#18283A;font-size:14px;font-weight:600;text-align:right">${esc(v)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(ctx.tenant_name)}</title></head><body style="margin:0;background:#F7F5F0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${color};padding:20px 24px;color:${fg};font-size:18px;font-weight:700">${logo}<span style="vertical-align:middle">${esc(ctx.tenant_name)}</span></td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 16px;color:#18283A;font-size:15px;line-height:1.5">${esc(m.intro)}</p>
${rows ? `<table role="presentation" width="100%">${rows}</table>` : ''}
<p style="margin:24px 0 0"><a href="${esc(m.cta[1])}" style="display:inline-block;background:#101F30;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(m.cta[0])}</a></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;color:#526174;font-size:11px">Tecnologia Portaria Prime · Cada encomenda. Tudo sob controle.</td></tr>
</table></td></tr></table></body></html>`;
}
