/**
 * Textos e menus do Portaria Prime IA. Puro (sem rede/banco): testável e reaproveitado pelo simulador da /demonstracao.
 * Toda opção aparece também numerada no texto (reserva quando o aparelho não mostra botões).
 */
export type Level = 'basic' | 'intermediate' | 'advanced';
export type Period = 'today' | 'month' | '3m' | '6m' | 'year';
export const PERIODS: Record<Period, string> = { today: 'Hoje', month: 'Último mês', '3m': 'Últimos 3 meses', '6m': 'Últimos 6 meses', year: 'Último ano' };
export const LEVELS: Record<Level, { title: string; desc: string }> = {
  basic: { title: 'Básico', desc: 'Consultas, pendências e relatórios. Não altera nada.' },
  intermediate: { title: 'Intermediário', desc: 'Básico + ações (aprovar cadastro, destinar, devolver, palavra-chave), sempre com confirmação.' },
  advanced: { title: 'Avançado', desc: 'Intermediário + áudio, foto de etiqueta e de CNH, sempre com confirmação.' },
};
const RANK: Record<Level, number> = { basic: 1, intermediate: 2, advanced: 3 };
export const allows = (level: Level, need: Level) => RANK[level] >= RANK[need];

const n = (v: unknown) => Number(v || 0);
const plural = (q: number, one: string, many: string) => `${q} ${q === 1 ? one : many}`;

export interface Opt { id: string; title: string }

/** Menu principal conforme o papel e o nível do número. */
export function menu(who: { full_name: string; tenant_name: string; level: Level; is_admin: boolean; can_approve: boolean }): { text: string; options: Opt[] } {
  const options: Opt[] = [{ id: 'today', title: '📋 Pendências de hoje' }, { id: 'pending', title: '📦 Aguardando retirada' }];
  if (who.is_admin) options.push({ id: 'reports', title: '📊 Relatórios' });
  if (who.can_approve) options.push({ id: 'requests', title: '👤 Cadastros pendentes' }, { id: 'unidentified', title: '❓ Sem identificação' });
  options.push({ id: 'keywords', title: '🔑 Palavras-chave' }, { id: 'help', title: 'ℹ️ O que posso pedir' });
  return {
    text: `Olá, ${who.full_name.split(' ')[0]}! Portaria Prime IA · ${who.tenant_name}\nNível: ${LEVELS[who.level].title}.\nEscolha uma opção, escreva${allows(who.level, 'advanced') ? ', mande um áudio ou a foto de uma etiqueta' : ' o que precisa'}.`,
    options,
  };
}

export function helpText(level: Level) {
  const lines = ['Exemplos do que você pode pedir:', '• "Liste as pendências de hoje"', '• "Quem tem encomenda no bloco 01A?"', '• "Analise a operação dos últimos 6 meses"'];
  if (allows(level, 'intermediate')) lines.push('• "Aprova o cadastro do João do bloco 02B apto 11"', '• "Devolve a encomenda #A1B2C3: endereço errado"');
  if (allows(level, 'advanced')) lines.push('• Mande um áudio com o pedido', '• Mande a foto da etiqueta para registrar a encomenda', '• Mande a foto da CNH para cadastrar o entregador');
  lines.push('', 'Nada é alterado sem você tocar em ✅ Confirmar.', 'Planilhas: use o importador no painel (Unidades e moradores › Importar).');
  return lines.join('\n');
}

export function todayText(d: any) {
  const lines = [`📋 Pendências de hoje`, '',
    `📦 Aguardando retirada: ${n(d.waiting)}`, `⏰ Há mais de 7 dias: ${n(d.overdue_7d)} (mais de 72 h: ${n(d.overdue_72h)})`,
    `🚫 Recusadas pelo morador (devolver): ${n(d.rejected)}`, `❓ Sem identificação: ${n(d.unidentified)}`,
    `👤 Cadastros aguardando aprovação: ${n(d.access_requests)}`, `🔑 Palavras-chave ativas: ${n(d.keywords)}`,
    `Hoje: ${plural(n(d.received_today), 'recebida', 'recebidas')} e ${plural(n(d.picked_today), 'entregue', 'entregues')}.`];
  if (Array.isArray(d.oldest) && d.oldest.length) {
    lines.push('', 'Mais antigas:');
    for (const p of d.oldest) lines.push(`• #${p.ref} ${p.unit || 'sem unidade'} · ${p.carrier}${p.recipient ? ` · ${p.recipient}` : ''} · ${p.days} dia(s)`);
  }
  return lines.join('\n');
}

export function pendingText(rows: any[], filter?: string) {
  if (!rows.length) return `Nenhuma encomenda aguardando retirada${filter ? ` em ${filter}` : ''}. ✅`;
  return [`📦 Aguardando retirada${filter ? ` · ${filter}` : ''} (${rows.length})`, '',
    ...rows.map((p) => `• #${p.ref} ${p.unit} · ${p.carrier}${p.recipient ? ` · ${p.recipient}` : ''} · ${p.days} dia(s)${p.storage ? ` · ${p.storage}` : ''}${p.rejected ? ' · 🚫 recusada' : ''}`)].join('\n');
}

export function reportText(period: Period, r: any) {
  const occ = r.occupancy ? `${n(r.occupancy.used)}/${n(r.occupancy.capacity)} (${n(r.occupancy.capacity) ? Math.round((n(r.occupancy.used) / n(r.occupancy.capacity)) * 100) : 0}%)` : '—';
  const carriers = (r.carriers || []).slice(0, 5).map((c: any, i: number) => `${i + 1}. ${c.carrier}: ${c.n}`).join('\n') || '—';
  const porters = (r.porters || []).slice(0, 5).map((p: any, i: number) => `${i + 1}. ${p.name}: ${p.n}`).join('\n') || '—';
  return [`📊 Relatório · ${PERIODS[period]}`, `${fmtDate(r.from)} a ${fmtDate(r.to)}`, '',
    `Recebidas: ${n(r.received)}`, `Entregues: ${n(r.delivered)}`, `Aguardando agora: ${n(r.pending_now)} (atrasadas: ${n(r.overdue_now)})`,
    `Tempo médio até a retirada: ${r.avg_pickup_h == null ? '—' : `${Number(r.avg_pickup_h).toFixed(1)} h`}`, `Ocupação das estantes: ${occ}`,
    `Recusadas pelo morador: ${n(r.rejected)}`, `Sem identificação: ${n(r.unidentified)}`, `Entregadores identificados: ${n(r.couriers)}`,
    '', 'Transportadoras:', carriers, '', 'Recebimentos por porteiro:', porters].join('\n');
}

export function listText(title: string, rows: string[], empty: string) {
  return rows.length ? [title, '', ...rows.map((r) => `• ${r}`)].join('\n') : empty;
}

const fmtDate = (d: string) => (d ? d.split('-').reverse().join('/') : '');

export function doneText(action: string, result: any) {
  const map: Record<string, string> = {
    approve_resident: 'Cadastro aprovado. O morador já pode entrar no app. ✅',
    reject_resident: 'Cadastro recusado e registrado. ✅',
    destinate_package: 'Encomenda destinada. Os moradores da unidade foram avisados. ✅',
    return_package: 'Devolução registrada no histórico. ✅',
    keyword_used: 'Palavra-chave marcada como utilizada. ✅',
    receive_package: `Feito! Encomenda registrada${result?.storage_code ? ` (guardar em ${result.storage_code})` : ''} e moradores notificados. ✅`,
    register_courier: 'Entregador cadastrado. ✅',
  };
  return map[action] || 'Feito! ✅';
}
