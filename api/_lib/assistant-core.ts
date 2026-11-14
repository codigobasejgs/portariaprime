/**
 * Núcleo do Portaria Prime IA: telas, propostas (resumo + ✅) e roteamento de cliques/intenções.
 * Sem SDK de IA nem OCR: roda no servidor (webhook) e no navegador (simulador da /demonstracao) com o MESMO código.
 * O cliente "svc" só precisa de rpc() e from(): no servidor é o Supabase service_role; na demonstração, o banco local.
 * Regras de segurança: ver api/_lib/assistant.ts e as migrations 20261113000100 e 20261114000200.
 */
import { confirmCode, numberedCard, type Card } from './whatsapp-card.js';
import { allows, doneText, helpText, listText, menu, packageText, PERIODS, pendingText, reportText, residentsText, storageText, todayText, type Level, type Period } from './assistant-text.js';

/** Subconjunto do cliente Supabase usado aqui (permite o banco simulado da demonstração). */
export interface Svc {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }>;
  from: (table: string) => any;
}
export interface Intent { name: string; args: Record<string, any> }

const RELATION: Record<string, string> = { proprietario: 'Proprietário(a)', locatario: 'Locatário(a)', dependente: 'Dependente/familiar', funcionario: 'Funcionário(a)' };

export interface Link { link_id: string; tenant_id: string; tenant_name: string; level: Level; role: string; can_approve: boolean; is_admin: boolean; full_name: string; timezone: string; feature_ocr: boolean }
export interface Reply { card: Card; options: string[] }
type Media = { mimetype: string; data: string } | undefined;

export const text = (t: string): Reply => ({ card: { text: t.slice(0, 3900) }, options: [] });
export const choose = (t: string, opts: { id: string; title: string }[], asList = false): Reply => {
  const { card, ids } = numberedCard(t, opts, asList || opts.length > 3);
  return { card, options: ids };
};
export const backToMenu = (t: string) => choose(t, [{ id: 'menu', title: '🏠 Menu' }]);

export class AssistantError extends Error {}

export async function read(svc: Svc, link: Link, kind: string, args: Record<string, unknown> = {}) {
  const { data, error } = await svc.rpc('assistant_read', { p_link: link.link_id, p_kind: kind, p_args: args });
  if (error) throw new AssistantError(error.message);
  return data as any;
}

/** Ação de escrita: grava a pendente (resumo + 10 min) e devolve o card de confirmação. */
export async function propose(svc: Svc, link: Link, action: string, params: Record<string, unknown>, summary: string): Promise<Reply> {
  const { data, error } = await svc.rpc('assistant_propose', { p_link: link.link_id, p_action: action, p_params: params, p_summary: summary });
  if (error) return backToMenu(`⛔ ${error.message}`);
  // Sem lista numerada: confirmar por número poderia acertar outra proposta. Botão ou código desta proposta.
  const code = confirmCode(data.id).toUpperCase();
  return {
    card: { text: `📝 Confira antes de confirmar:\n\n${summary}\n\nVálido por 10 minutos. Nada é gravado sem o ✅.\nSem botões? Responda CONFIRMAR ${code} ou CANCELAR.`,
      buttons: [{ id: `ok:${data.id}`, title: '✅ Confirmar' }, { id: `no:${data.id}`, title: '❌ Cancelar' }] },
    options: [`ok:${data.id}`, `no:${data.id}`],
  };
}

export const NEED_INTERMEDIATE = 'Seu número está no nível Básico (só consultas). Peça ao síndico para mudar o nível em Configurações › Assistente no WhatsApp.';
export const NEED_ADVANCED = 'Áudio, foto e arquivos exigem o nível Avançado. Peça ao síndico para mudar o nível em Configurações › Assistente no WhatsApp.';

// ------------------------------------------------------------------------- telas
async function today(svc: Svc, link: Link) {
  return choose(todayText(await read(svc, link, 'today')), [{ id: 'pending', title: '📦 Ver aguardando' }, { id: 'menu', title: '🏠 Menu' }]);
}

async function pending(svc: Svc, link: Link, block?: string | null, unit?: string | null) {
  const rows = await read(svc, link, 'pending_by_unit', { block: block || null, unit: unit || null });
  const filter = [block && `bloco ${block}`, unit && `unidade ${unit}`].filter(Boolean).join(' ');
  return backToMenu(pendingText(rows, filter || undefined));
}

async function report(svc: Svc, link: Link, period: Period) {
  if (!link.is_admin) return backToMenu('Relatórios são do síndico/administrador.');
  return choose(reportText(period, await read(svc, link, 'report', { period })), [{ id: 'reports', title: '📊 Outro período' }, { id: 'menu', title: '🏠 Menu' }]);
}

async function requests(svc: Svc, link: Link) {
  if (!link.can_approve) return backToMenu('Somente quem aprova cadastros vê esta lista.');
  const rows: any[] = await read(svc, link, 'access_requests');
  if (!rows.length) return backToMenu('Nenhum cadastro aguardando aprovação. ✅');
  const head = listText(`👤 Cadastros pendentes (${rows.length})`, rows.map((r) => `${r.name} · ${r.unit}`), '');
  if (!allows(link.level, 'intermediate')) return backToMenu(head);
  return choose(`${head}\n\nToque para aprovar. Para recusar: "recusa o cadastro de <nome>: <motivo>".`, rows.slice(0, 10).map((r) => ({ id: `ap:${r.id}`, title: `${r.name}`.slice(0, 24) })), true);
}

async function unidentified(svc: Svc, link: Link) {
  if (!link.can_approve) return backToMenu('Somente quem aprova cadastros destina encomendas sem identificação.');
  const rows: any[] = await read(svc, link, 'unidentified');
  return backToMenu(listText(`❓ Sem identificação (${rows.length})`, rows.map((r) => `#${r.ref} ${r.unit || 'sem unidade'} · ${r.carrier}${r.recipient ? ` · ${r.recipient}` : ''}`),
    'Nenhuma encomenda sem identificação. ✅') + (rows.length && allows(link.level, 'intermediate') ? '\n\nPara destinar, escreva: "destina #REF para bloco X apto Y".' : ''));
}

async function keywords(svc: Svc, link: Link) {
  const rows: any[] = await read(svc, link, 'keywords');
  if (!rows.length) return backToMenu('Nenhuma palavra-chave ativa. ✅');
  const head = listText(`🔑 Palavras-chave ativas (${rows.length})`, rows.map((k) => `${k.keyword} · ${k.unit}${k.carrier ? ` · ${k.carrier}` : ''}`), '');
  if (!allows(link.level, 'intermediate')) return backToMenu(head);
  return choose(`${head}\n\nToque numa palavra para marcar como utilizada ou cancelar. Para criar: "cria a palavra AZUL para o bloco 2 apto 11".`,
    rows.slice(0, 10).map((k) => ({ id: `ko:${k.id}`, title: `${k.keyword} ${k.unit}`.slice(0, 24) })), true);
}

// ------------------------------------------------------------------------- propostas
async function proposeApprove(svc: Svc, link: Link, requestId: string) {
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  if (!link.can_approve) return backToMenu('Somente quem aprova cadastros pode aprovar.');
  const r = (await read(svc, link, 'access_requests') as any[]).find((x) => x.id === requestId);
  if (!r) return backToMenu('Cadastro não encontrado ou já decidido.');
  return propose(svc, link, 'approve_resident', { request_id: r.id, unit_id: r.unit_id || null },
    `Ação: aprovar cadastro de morador\nMorador: ${r.name}\nUnidade: ${r.unit}${r.relation ? `\nRelação: ${RELATION[r.relation] || r.relation}` : ''}`);
}

async function proposeKeyword(svc: Svc, link: Link, keywordId: string) {
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  const k = (await read(svc, link, 'keywords') as any[]).find((x) => x.id === keywordId);
  if (!k) return backToMenu('Palavra-chave não encontrada ou já utilizada.');
  return propose(svc, link, 'keyword_used', { keyword_id: k.id }, `Ação: marcar palavra-chave como utilizada\nPalavra: ${k.keyword}\nUnidade: ${k.unit}`);
}

/** Encomenda pela referência curta (#A1B2C3) entre as que aguardam retirada ou estão sem identificação. */
async function findPackage(svc: Svc, link: Link, ref: string) {
  const want = ref.replace(/^#/, '').toUpperCase();
  const pend: any[] = await read(svc, link, 'pending_by_unit', {});
  const hit = pend.find((p) => p.ref === want);
  if (hit) return hit;
  if (!link.can_approve) return null;
  return (await read(svc, link, 'unidentified') as any[]).find((p) => p.ref === want) || null;
}

async function unitByText(svc: Svc, link: Link, block: string | null, unit: string | null) {
  if (!unit) return { error: 'Informe a unidade (ex.: bloco 02B apto 11).' };
  const units: any[] = await read(svc, link, 'unit_lookup', { block, unit });
  if (units.length === 1) return { unit: units[0] };
  return { error: units.length ? `Encontrei ${units.length} unidades "${unit}". Informe também o bloco.` : `Unidade ${[block, unit].filter(Boolean).join(' ')} não encontrada.` };
}


const s = (v: unknown, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// ------------------------------------------------------------------------- encomendas: busca, detalhe e ações
/** Lista de encomendas como opções tocáveis (pk:<id>) com o texto também numerado. */
function packageList(title: string, rows: any[], empty: string): Reply {
  if (!rows.length) return backToMenu(empty);
  const body = listText(title, rows.map((p) => `#${p.ref} ${p.unit || 'sem unidade'} · ${p.carrier}${p.recipient ? ` · ${p.recipient}` : ''} · ${p.days}d${p.storage ? ` · ${p.storage}` : ''}`), empty);
  return choose(`${body}\n\nToque numa encomenda para ver as ações:`, rows.slice(0, 9).map((p) => ({ id: `pk:${p.id}`, title: `#${p.ref} ${p.unit || ''}`.slice(0, 24) }))
    .concat({ id: 'menu', title: '🏠 Menu' }), true);
}

async function find(svc: Svc, link: Link, args: { q?: string | null; min_days?: number | null; block?: string | null; id?: string }) {
  return (await read(svc, link, 'find_packages', { q: args.q || null, min_days: args.min_days ?? null, block: args.block || null, id: args.id || null })) as any[];
}
/** Uma encomenda aguardando retirada pelo id (botões): busca exata, não depende da lista das 20 mais antigas. */
const byId = async (svc: Svc, link: Link, id: string) => (await find(svc, link, { id })).find((x) => x.id === id) || null;

async function late(svc: Svc, link: Link) {
  const rows = await find(svc, link, { min_days: 7 });
  if (!rows.length) return backToMenu('Nenhuma encomenda parada há 7 dias ou mais. ✅');
  const body = listText(`⏰ Aguardando há 7+ dias (${rows.length})`, rows.map((p) => `#${p.ref} ${p.unit || 'sem unidade'} · ${p.carrier} · ${p.days}d`), '');
  // Atalho de lote: reenviar o aviso de todas (até 20, com resumo e ✅) + as 8 mais antigas tocáveis.
  const opts = allows(link.level, 'intermediate') ? [{ id: 'bulk:late', title: '📣 Reenviar a todas' }] : [];
  return choose(`${body}\n\nToque numa encomenda para ver as ações${opts.length ? ' ou reenvie o aviso de todas' : ''}:`,
    opts.concat(rows.slice(0, 8).map((p) => ({ id: `pk:${p.id}`, title: `#${p.ref} ${p.unit || ''}`.slice(0, 24) })), { id: 'menu', title: '🏠 Menu' }), true);
}

async function packageMenu(svc: Svc, link: Link, id: string) {
  const p = await byId(svc, link, id);
  if (!p) return backToMenu('Encomenda não encontrada ou já retirada.');
  if (!allows(link.level, 'intermediate')) return backToMenu(packageText(p));
  const opts = [{ id: `rs:${p.id}`, title: '📣 Reenviar aviso' }, { id: `mv:${p.id}`, title: '🗄️ Mover de local' }];
  if (!p.unidentified) opts.push({ id: `un:${p.id}`, title: '❓ Sem identificação' });
  opts.push({ id: `dv:${p.id}`, title: '↩️ Devolver' });
  if (link.is_admin) opts.push({ id: `cx:${p.id}`, title: '🛑 Cancelar/extravio' });
  opts.push({ id: 'menu', title: '🏠 Menu' });
  return choose(`${packageText(p)}\n\nO que fazer?`, opts, true);
}

async function packageAction(svc: Svc, link: Link, kind: string, id: string, extra?: string): Promise<Reply> {
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  const p = await byId(svc, link, id);
  if (!p) return backToMenu('Encomenda não encontrada ou já retirada.');
  const head = `Encomenda: #${p.ref} · ${p.unit || 'sem unidade'} · ${p.carrier}${p.recipient ? ` · ${p.recipient}` : ''}`;
  if (kind === 'rs') return propose(svc, link, 'resend_notice', { package_id: p.id }, `Ação: reenviar aviso de retirada\n${head}\nOs moradores da unidade recebem o aviso de novo.`);
  if (kind === 'un') return propose(svc, link, 'mark_unidentified', { package_id: p.id, reason: 'incomplete_or_unknown_name' },
    `Ação: marcar como sem identificação\n${head}\nVai para a lista do síndico destinar.`);
  if (kind === 'dv') return backToMenu(`Para devolver, escreva o motivo: "devolve #${p.ref}: <motivo>" (mínimo 10 caracteres).`);
  if (kind === 'cx') {
    if (!link.is_admin) return backToMenu('Cancelar ou marcar extravio é do síndico/administrador.');
    return backToMenu(`Escreva: "cancela #${p.ref}: <motivo>" ou "extravio #${p.ref}: <motivo>" (mínimo 10 caracteres).`);
  }
  if (kind === 'mv') {
    const spots = ((await read(svc, link, 'storage')) as any[]).filter((x) => x.id !== p.storage_id && x.free > 0);
    if (extra) {
      const to = spots.find((x) => x.id === extra);
      if (!to) return backToMenu('Local lotado ou inválido. Escolha de novo.');
      return propose(svc, link, 'move_package', { package_id: p.id, storage_location_id: to.id },
        `Ação: mover encomenda\n${head}\nDe: ${p.storage || '—'}\nPara: ${to.name}\nAo confirmar, você declara que ela já está no novo local.`);
    }
    if (!spots.length) return backToMenu('Nenhum outro local com espaço livre.');
    // Título do botão (24 caracteres): a parte final do caminho (estante › prateleira) é a que diferencia os locais.
    const short = (name: string) => { const parts = name.split(' › '); return (parts.length > 1 ? parts.slice(1).join(' › ') : name).slice(0, 24); };
    return choose(`Mover #${p.ref} para qual local?\n${spots.slice(0, 9).map((x) => `• ${x.name} (${x.free} livres)`).join('\n')}`,
      spots.slice(0, 9).map((x) => ({ id: `mt:${p.id}:${x.id}`, title: short(x.name) })).concat({ id: 'menu', title: '🏠 Menu' }), true);
  }
  return mainMenu(link);
}

/** Lote: até 20 encomendas por confirmação, listadas no resumo. */
async function bulk(svc: Svc, link: Link, kind: 'bulk_resend' | 'bulk_return', rows: any[], reason?: string | null): Promise<Reply> {
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  if (!rows.length) return backToMenu('Nenhuma encomenda encontrada para essa ação.');
  const items = rows.slice(0, 20);
  const more = rows.length > 20 ? `\n(+${rows.length - 20} ficam para a próxima confirmação)` : '';
  const list = items.map((p) => `• #${p.ref} ${p.unit || 'sem unidade'} · ${p.carrier} · ${p.days}d`).join('\n');
  if (kind === 'bulk_return') {
    if (!reason || reason.length < 10) return backToMenu('Diga o motivo da devolução (mínimo 10 caracteres).');
    return propose(svc, link, kind, { package_ids: items.map((p) => p.id), reason }, `Ação: devolver ${items.length} encomenda(s) ao remetente\nMotivo: ${reason}\n${list}${more}`);
  }
  return propose(svc, link, kind, { package_ids: items.map((p) => p.id) }, `Ação: reenviar aviso de ${items.length} encomenda(s)\n${list}${more}`);
}

// ------------------------------------------------------------------------- cadastros, convites, palavras-chave, estantes
async function proposeReject(svc: Svc, link: Link, requestId: string, reason: string | null) {
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  if (!link.can_approve) return backToMenu('Somente quem aprova cadastros pode recusar.');
  const r = (await read(svc, link, 'access_requests') as any[]).find((x) => x.id === requestId);
  if (!r) return backToMenu('Cadastro não encontrado ou já decidido.');
  if (!reason || reason.length < 5) return backToMenu(`Para recusar, escreva: "recusa o cadastro de ${r.name.split(' ')[0]}: <motivo>".`);
  return propose(svc, link, 'reject_resident', { request_id: r.id, reason }, `Ação: recusar cadastro de morador\nMorador: ${r.name}\nUnidade: ${r.unit}\nMotivo: ${reason}`);
}

async function invites(svc: Svc, link: Link) {
  if (!link.can_approve) return backToMenu('Somente quem aprova cadastros convida moradores.');
  const v: any = await read(svc, link, 'invite_preview');
  const eligible = Number(v?.eligible || 0);
  const out = Array.isArray(v?.left_out) ? v.left_out.length : 0;
  const head = `✉️ Convites do pré-cadastro\nUnidades sem cadastro com WhatsApp: ${eligible}${out ? `\nFicam de fora: ${out} (sem contato ou já cadastrados)` : ''}`;
  if (!eligible) return backToMenu(`${head}\n\nNinguém para convidar agora. Para incluir pessoas, mande a planilha (nível Avançado) ou use o painel.`);
  if (!allows(link.level, 'intermediate')) return backToMenu(head);
  const n = Math.min(eligible, Number(v?.limit || 100));
  return propose(svc, link, 'invite_residents', { limit: n }, `Ação: convidar moradores pelo WhatsApp\n${head}\nSerão enviados: ${n} (aos poucos, pelo WhatsApp dos avisos)\nCada convite leva ao cadastro já com a unidade; você ainda aprova cada um.`);
}

async function keywordCreate(svc: Svc, link: Link, a: Record<string, any>) {
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  const word = s(a.keyword, 60);
  if (!word || word.length < 2) return backToMenu('Diga a palavra-chave (2 a 60 caracteres).');
  const u = await unitByText(svc, link, s(a.block, 30), s(a.unit, 30));
  if (!u.unit) return backToMenu(u.error!);
  return propose(svc, link, 'keyword_create', { unit_id: u.unit.id, keyword: word, carrier: s(a.carrier, 40), recipient: s(a.recipient, 120) },
    `Ação: cadastrar palavra-chave de entrega\nPalavra: ${word}\nUnidade: ${u.unit.unit}${a.carrier ? `\nTransportadora: ${s(a.carrier, 40)}` : ''}${a.recipient ? `\nPara: ${s(a.recipient, 120)}` : ''}`);
}

async function proposeKeywordCancel(svc: Svc, link: Link, keywordId: string) {
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  const k = (await read(svc, link, 'keywords') as any[]).find((x) => x.id === keywordId);
  if (!k) return backToMenu('Palavra-chave não encontrada ou já utilizada.');
  return propose(svc, link, 'keyword_cancel', { keyword_id: k.id }, `Ação: cancelar palavra-chave\nPalavra: ${k.keyword}\nUnidade: ${k.unit}`);
}

async function keywordMenu(svc: Svc, link: Link, keywordId: string) {
  const k = (await read(svc, link, 'keywords') as any[]).find((x) => x.id === keywordId);
  if (!k) return backToMenu('Palavra-chave não encontrada ou já utilizada.');
  if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
  return choose(`🔑 ${k.keyword} · ${k.unit}${k.carrier ? ` · ${k.carrier}` : ''}`,
    [{ id: `kw:${k.id}`, title: '✅ Marcar utilizada' }, { id: `kc:${k.id}`, title: '🗑️ Cancelar palavra' }, { id: 'menu', title: '🏠 Menu' }]);
}

/** Executa a intenção escolhida pela IA: leituras respondem; ações viram proposta com resumo. */
export async function runIntent(svc: Svc, link: Link, intent: Intent | null): Promise<Reply> {
  if (!intent || intent.name === 'show_menu') return mainMenu(link, 'Não entendi bem. Veja o que posso fazer:');
  const a = intent.args;
  switch (intent.name) {
    case 'today_summary': return today(svc, link);
    case 'pending_packages': return pending(svc, link, s(a.block, 30), s(a.unit, 30));
    case 'report': return Object.hasOwn(PERIODS, a.period) ? report(svc, link, a.period) : reportMenu(link);
    case 'list_access_requests': return requests(svc, link);
    case 'list_unidentified': return unidentified(svc, link);
    case 'list_keywords': return keywords(svc, link);
    case 'approve_resident': {
      if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
      if (!link.can_approve) return backToMenu('Somente quem aprova cadastros pode aprovar.');
      const name = (s(a.name, 120) || '').toLowerCase();
      const unit = (s(a.unit, 30) || '').toLowerCase();
      const rows: any[] = await read(svc, link, 'access_requests');
      const hits = rows.filter((r) => r.name.toLowerCase().includes(name) && (!unit || r.unit.toLowerCase().includes(unit)));
      if (hits.length === 1) return proposeApprove(svc, link, hits[0].id);
      if (!hits.length) return requests(svc, link);
      return choose('Encontrei mais de um cadastro. Qual deles?', hits.slice(0, 10).map((r) => ({ id: `ap:${r.id}`, title: `${r.name} ${r.unit}`.slice(0, 24) })), true);
    }
    case 'destinate_package': {
      if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
      if (!link.can_approve) return backToMenu('Somente quem aprova cadastros destina encomendas sem identificação.');
      const ref = s(a.ref, 10);
      const pkg = ref ? (await read(svc, link, 'unidentified') as any[]).find((p) => p.ref === ref.replace(/^#/, '').toUpperCase()) : null;
      if (!pkg) return backToMenu(`Encomenda sem identificação #${ref || '?'} não encontrada.`);
      const u = await unitByText(svc, link, s(a.block, 30), s(a.unit, 30));
      if (!u.unit) return backToMenu(u.error!);
      const recipient = s(a.recipient, 120) || pkg.recipient || null;
      const resident = (u.unit.residents || []).find((r: any) => r.status === 'active' && recipient && r.name.toLowerCase() === recipient.toLowerCase());
      return propose(svc, link, 'destinate_package', { package_id: pkg.id, unit_id: u.unit.id, recipient, resident_user: null },
        `Ação: destinar encomenda sem identificação\nEncomenda: #${pkg.ref} · ${pkg.carrier}\nPara: ${u.unit.unit}\nDestinatário: ${recipient || '—'}${resident ? ' (morador ativo)' : ''}\nOs moradores da unidade serão avisados.`);
    }
    case 'return_package': {
      if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
      const reason = s(a.reason, 300);
      if (!reason || reason.length < 10) return backToMenu('Diga o motivo da devolução (mínimo 10 caracteres).');
      const ref = s(a.ref, 10) || '';
      const pkg = await findPackage(svc, link, ref);
      if (!pkg?.id && !pkg?.ref) return backToMenu(`Encomenda #${ref} não encontrada entre as que aguardam retirada.`);
      const id = pkg.id || (await read(svc, link, 'unidentified') as any[]).find((p) => p.ref === pkg.ref)?.id
        || (await find(svc, link, { q: pkg.ref })).find((p) => p.ref === pkg.ref)?.id;
      if (!id) return backToMenu(`Encomenda #${ref} não encontrada.`);
      return propose(svc, link, 'return_package', { package_id: id, reason },
        `Ação: registrar devolução ao remetente\nEncomenda: #${pkg.ref} · ${pkg.unit || 'sem unidade'} · ${pkg.carrier}\nMotivo: ${reason}`);
    }
    // ---------------------------------------------------------------- novas
    case 'find_package': {
      const rows = await find(svc, link, { q: s(a.query, 60), min_days: Number.isFinite(a.min_days) ? a.min_days : null, block: s(a.block, 30) });
      if (rows.length === 1) return packageMenu(svc, link, rows[0].id);
      return packageList(`🔎 Encomendas encontradas (${rows.length})`, rows, 'Nenhuma encomenda aguardando retirada com esse dado.');
    }
    case 'unit_residents': {
      if (!s(a.unit, 30)) return backToMenu('Informe a unidade (ex.: bloco 02B apto 11).');
      return backToMenu(residentsText(await read(svc, link, 'unit_residents', { block: s(a.block, 30), unit: s(a.unit, 30) })));
    }
    case 'storage_status': return storageView(svc, link);
    case 'reject_resident': {
      if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
      if (!link.can_approve) return backToMenu('Somente quem aprova cadastros pode recusar.');
      const name = (s(a.name, 120) || '').toLowerCase();
      const rows: any[] = await read(svc, link, 'access_requests');
      const hits = rows.filter((r) => name && r.name.toLowerCase().includes(name));
      if (hits.length === 1) return proposeReject(svc, link, hits[0].id, s(a.reason, 300));
      return hits.length ? choose('Encontrei mais de um cadastro. Diga o nome completo e o motivo.', [{ id: 'requests', title: '👤 Ver cadastros' }]) : requests(svc, link);
    }
    case 'resend_notice': {
      const ref = s(a.ref, 10);
      const rows = ref ? await find(svc, link, { q: ref }) : [];
      return rows.length === 1 ? packageAction(svc, link, 'rs', rows[0].id) : backToMenu(`Encomenda #${ref || '?'} não encontrada entre as que aguardam retirada.`);
    }
    case 'bulk_resend': {
      const min = Number.isFinite(a.min_days) ? Math.max(0, Math.min(365, a.min_days)) : 7;
      return bulk(svc, link, 'bulk_resend', await find(svc, link, { min_days: min, block: s(a.block, 30) }));
    }
    case 'bulk_return': {
      const min = Number.isFinite(a.min_days) ? Math.max(0, Math.min(365, a.min_days)) : null;
      if (min == null && !s(a.block, 30)) return backToMenu('Para devolver em lote, diga o critério (ex.: "devolve as paradas há mais de 30 dias: prazo vencido").');
      return bulk(svc, link, 'bulk_return', await find(svc, link, { min_days: min, block: s(a.block, 30) }), s(a.reason, 300));
    }
    case 'cancel_package': {
      if (!allows(link.level, 'intermediate')) return backToMenu(NEED_INTERMEDIATE);
      if (!link.is_admin) return backToMenu('Cancelar ou marcar extravio é do síndico/administrador.');
      const reason = s(a.reason, 300);
      if (!reason || reason.length < 10) return backToMenu('Diga o motivo (mínimo 10 caracteres).');
      const rows = await find(svc, link, { q: s(a.ref, 10) });
      if (rows.length !== 1) return backToMenu(`Encomenda #${s(a.ref, 10) || '?'} não encontrada entre as que aguardam retirada.`);
      const status = a.lost ? 'EXTRAVIADA' : 'CANCELADA';
      const p = rows[0];
      return propose(svc, link, 'cancel_package', { package_id: p.id, status, reason },
        `Ação: ${status === 'EXTRAVIADA' ? 'marcar como extraviada' : 'cancelar encomenda'}\nEncomenda: #${p.ref} · ${p.unit || 'sem unidade'} · ${p.carrier}\nMotivo: ${reason}`);
    }
    case 'create_keyword': return keywordCreate(svc, link, a);
    case 'invite_residents': return invites(svc, link);
  }
  return mainMenu(link);
}

async function storageView(svc: Svc, link: Link) {
  return backToMenu(storageText(await read(svc, link, 'storage')));
}


// ------------------------------------------------------------------------- menus
export function mainMenu(link: Link, prefix?: string): Reply {
  const m = menu(link);
  return choose(prefix ? `${prefix}\n\n${m.text}` : m.text, m.options, true);
}
export function reportMenu(link: Link): Reply {
  if (!link.is_admin) return backToMenu('Relatórios são do síndico/administrador.');
  return choose('📊 Relatório de qual período?', (Object.keys(PERIODS) as Period[]).map((p) => ({ id: `rp:${p}`, title: PERIODS[p] })), true);
}

/** Clique de botão/lista (ou número digitado). Ids conhecidos; o resto vai para o menu. */
export async function handleAction(svc: Svc, link: Link, id: string): Promise<Reply> {
  const [kind, arg] = [id.split(':')[0], id.slice(id.indexOf(':') + 1)];
  const uuid = /^[0-9a-f-]{36}$/i.test(arg) ? arg : null;
  switch (kind) {
    case 'menu': return mainMenu(link);
    case 'help': return backToMenu(helpText(link.level));
    case 'today': return today(svc, link);
    case 'pending': return pending(svc, link);
    case 'reports': return reportMenu(link);
    case 'rp': return Object.hasOwn(PERIODS, arg) ? report(svc, link, arg as Period) : reportMenu(link);
    case 'requests': return requests(svc, link);
    case 'unidentified': return unidentified(svc, link);
    case 'keywords': return keywords(svc, link);
    case 'ap': return uuid ? proposeApprove(svc, link, uuid) : mainMenu(link);
    case 'kw': return uuid ? proposeKeyword(svc, link, uuid) : mainMenu(link);
    case 'ko': return uuid ? keywordMenu(svc, link, uuid) : mainMenu(link);
    case 'kc': return uuid ? proposeKeywordCancel(svc, link, uuid) : mainMenu(link);
    case 'late': return late(svc, link);
    case 'storage': return storageView(svc, link);
    case 'invites': return invites(svc, link);
    case 'bulk': return arg === 'late' ? bulk(svc, link, 'bulk_resend', await find(svc, link, { min_days: 7 })) : mainMenu(link);
    case 'pk': return uuid ? packageMenu(svc, link, uuid) : mainMenu(link);
    case 'rs': case 'un': case 'dv': case 'cx': case 'mv': return uuid ? packageAction(svc, link, kind, uuid) : mainMenu(link);
    case 'mt': {
      // mt:<encomenda>:<local>
      const [pid, loc] = arg.split(':');
      return /^[0-9a-f-]{36}$/i.test(pid || '') && /^[0-9a-f-]{36}$/i.test(loc || '') ? packageAction(svc, link, 'mv', pid, loc) : mainMenu(link);
    }
    case 'ok': {
      if (!uuid) return mainMenu(link);
      const { data, error } = await svc.rpc('assistant_confirm', { p_link: link.link_id, p_pending: uuid });
      if (error) return backToMenu(`⛔ ${error.message}`);
      if (data.status === 'done') {
        const { data: p } = await svc.from('assistant_pending').select('action').eq('id', uuid).maybeSingle();
        return backToMenu(data.replayed ? 'Esta ação já tinha sido confirmada. ✅' : doneText(p?.action || '', data.result));
      }
      if (data.status === 'expired') return backToMenu('⏰ A confirmação venceu (10 minutos). Peça de novo.');
      if (data.status === 'cancelled') return backToMenu('Esta ação foi cancelada ou substituída por outra.');
      return backToMenu(`⛔ Não foi possível concluir: ${data.error || 'tente novamente pelo painel'}.`);
    }
    case 'no': {
      if (uuid) await svc.rpc('assistant_cancel', { p_link: link.link_id, p_pending: uuid });
      return backToMenu('Cancelado. Nada foi alterado. ❌');
    }
  }
  return mainMenu(link);
}

