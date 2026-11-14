// Portaria Prime IA — ações novas pelo WhatsApp: botões por encomenda, lote (até 20), recusa de cadastro,
// palavras-chave, convites e planilha. Toda escrita vira proposta com resumo; nada executa antes do ✅; níveis respeitados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAction, runIntent } from '../../api/_lib/assistant-core.ts';
import { menu } from '../../api/_lib/assistant-text.ts';
import { respond, handleSheet } from '../../api/_lib/assistant.ts';

const PID = '11111111-1111-4111-8111-111111111111';
const P1 = '00000000-0000-4000-8000-000000000001', P2 = '00000000-0000-4000-8000-000000000002';
const S1 = '00000000-0000-4000-8000-0000000000a1', S2 = '00000000-0000-4000-8000-0000000000a2';
const pkgs = [
  { id: P1, ref: '000000', unit: '01A 101', carrier: 'Shopee', recipient: 'Ana', tracking: 'BR1', storage: 'A1', storage_id: S1, days: 9, rejected: false, unidentified: false },
  { id: P2, ref: '000001', unit: '02B 11', carrier: 'Correios', recipient: 'Zé', tracking: 'BR2', storage: 'A1', storage_id: S1, days: 8, rejected: false, unidentified: false },
];
const link = (level, extra = {}) => ({ link_id: 'L1', tenant_id: 'T1', tenant_name: 'Cond A', level, role: 'admin', can_approve: true, is_admin: true, full_name: 'Maria',
  timezone: 'America/Sao_Paulo', feature_ocr: true, ...extra });

function fakeSvc(over = {}) {
  const calls = [];
  const reads = {
    find_packages: (a) => pkgs.filter((p) => (!a.id || p.id === a.id) && (!a.q || p.ref === String(a.q).replace(/^#/, '').toUpperCase() || p.recipient.toLowerCase().includes(String(a.q).toLowerCase()))
      && (a.min_days == null || p.days >= a.min_days)),
    storage: () => [{ id: S1, name: 'Portaria › A1', free: 3, capacity: 10 }, { id: S2, name: 'Portaria › B2', free: 5, capacity: 10 }],
    access_requests: () => [{ id: 'R1', name: 'Maria Silva', unit: '02B 11' }],
    keywords: () => [{ id: '22222222-2222-4222-8222-222222222222', keyword: 'AZUL', unit: '02B 11', carrier: null }],
    unit_lookup: () => [{ id: 'U1', unit: '02B 11', residents: [] }],
    unit_residents: () => [{ unit: '02B 11', residents: [{ name: 'Maria Silva', status: 'active' }, { name: 'João', status: 'pending' }] }],
    invite_preview: () => ({ eligible: 12, limit: 100, left_out: [{}, {}] }),
    units: () => [{ id: 'U1', block: '01A', label: '101', active: true }, { id: 'U2', block: '02B', label: '11', active: true }],
  };
  return {
    calls,
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      if (over[fn]) return over[fn](args);
      if (fn === 'assistant_read') return { data: reads[args.p_kind] ? reads[args.p_kind](args.p_args || {}) : [], error: null };
      if (fn === 'assistant_propose') return { data: { id: PID }, error: null };
      return { data: null, error: { message: `rpc ${fn} não simulada` } };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { action: 'bulk_resend' } }) }) }) }),
  };
}
const proposals = (svc) => svc.calls.filter(([fn]) => fn === 'assistant_propose').map(([, a]) => a);
const ids = (r) => r.card.buttons?.map((b) => b.id) || r.card.sections?.flatMap((s) => s.rows.map((x) => x.id)) || [];

test('menu: novos botões (atrasadas, estantes, convites) cabem na lista do WhatsApp (até 10)', () => {
  const m = menu({ full_name: 'Maria', tenant_name: 'Cond A', level: 'intermediate', is_admin: true, can_approve: true });
  const got = m.options.map((o) => o.id);
  for (const id of ['late', 'storage', 'invites', 'keywords', 'reports']) assert.ok(got.includes(id), id);
  assert.ok(got.length <= 10);
  const basic = menu({ full_name: 'Maria', tenant_name: 'Cond A', level: 'basic', is_admin: true, can_approve: true });
  assert.ok(!basic.options.some((o) => o.id === 'invites'), 'básico não vê convites');
});

test('encomenda: toque abre as ações; cada ação vira proposta com resumo, nada executa antes do ✅', async () => {
  const svc = fakeSvc();
  const m = await handleAction(svc, link('intermediate'), `pk:${P1}`);
  assert.match(m.card.text, /#000000 · 01A 101/); assert.match(m.card.text, /Rastreio: BR1/);
  assert.deepEqual(ids(m), [`rs:${P1}`, `mv:${P1}`, `un:${P1}`, `dv:${P1}`, `cx:${P1}`, 'menu']);
  const rs = await handleAction(svc, link('intermediate'), `rs:${P1}`);
  assert.match(rs.card.text, /reenviar aviso de retirada/); assert.deepEqual(rs.card.buttons.map((b) => b.id), [`ok:${PID}`, `no:${PID}`]);
  const un = await handleAction(svc, link('intermediate'), `un:${P1}`);
  assert.match(un.card.text, /sem identificação/);
  // Mover: escolhe o destino (só locais com vaga e diferentes do atual) e então propõe.
  const mv = await handleAction(svc, link('intermediate'), `mv:${P1}`);
  assert.deepEqual(ids(mv), [`mt:${P1}:${S2}`, 'menu']);
  const mt = await handleAction(svc, link('intermediate'), `mt:${P1}:${S2}`);
  assert.match(mt.card.text, /Para: Portaria › B2/);
  assert.deepEqual(proposals(svc).map((p) => [p.p_action, p.p_params]), [
    ['resend_notice', { package_id: P1 }], ['mark_unidentified', { package_id: P1, reason: 'incomplete_or_unknown_name' }],
    ['move_package', { package_id: P1, storage_location_id: S2 }]]);
  assert.ok(!svc.calls.some(([fn]) => fn === 'assistant_confirm'));
});

test('níveis e papéis: básico só consulta; porteiro não cancela; básico não vê ações da encomenda', async () => {
  const svc = fakeSvc();
  const m = await handleAction(svc, link('basic'), `pk:${P1}`);
  assert.deepEqual(ids(m), ['menu']);
  assert.match((await handleAction(svc, link('basic'), `rs:${P1}`)).card.text, /nível Básico/);
  assert.match((await runIntent(svc, link('basic'), { name: 'bulk_resend', args: {} })).card.text, /nível Básico/);
  assert.match((await runIntent(svc, link('basic'), { name: 'create_keyword', args: { keyword: 'AZUL', unit: '11' } })).card.text, /nível Básico/);
  const por = link('intermediate', { is_admin: false, role: 'porteiro', can_approve: false });
  assert.ok(!ids(await handleAction(svc, por, `pk:${P1}`)).includes(`cx:${P1}`), 'porteiro não vê cancelar');
  assert.match((await runIntent(svc, por, { name: 'cancel_package', args: { ref: '000000', reason: 'Pedido cancelado pela loja.' } })).card.text, /síndico/);
  assert.match((await runIntent(svc, por, { name: 'reject_resident', args: { name: 'Maria', reason: 'não mora' } })).card.text, /aprova cadastros/);
  assert.equal(proposals(svc).length, 0, 'nenhuma proposta criada');
});

test('lote: atrasadas viram UMA proposta com todas listadas (até 20); devolução em lote exige motivo', async () => {
  const svc = fakeSvc();
  const late = await handleAction(svc, link('intermediate'), 'late');
  assert.equal(ids(late)[0], 'bulk:late');
  const b = await handleAction(svc, link('intermediate'), 'bulk:late');
  assert.match(b.card.text, /reenviar aviso de 2 encomenda/); assert.match(b.card.text, /#000000/); assert.match(b.card.text, /#000001/);
  assert.match((await runIntent(svc, link('intermediate'), { name: 'bulk_return', args: { min_days: 30 } })).card.text, /Nenhuma encomenda|motivo/);
  const ret = await runIntent(svc, link('intermediate'), { name: 'bulk_return', args: { min_days: 7, reason: 'Prazo de retirada vencido.' } });
  assert.match(ret.card.text, /devolver 2 encomenda/);
  assert.deepEqual(proposals(svc).map((p) => [p.p_action, p.p_params.package_ids.length]), [['bulk_resend', 2], ['bulk_return', 2]]);
  // Mais de 20: só 20 entram, o resumo avisa o restante.
  const many = Array.from({ length: 25 }, (_, i) => ({ ...pkgs[0], id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`, ref: `R${i}` }));
  const svc2 = fakeSvc({ assistant_read: (a) => ({ data: a.p_kind === 'find_packages' ? many : [], error: null }) });
  const big = await runIntent(svc2, link('intermediate'), { name: 'bulk_resend', args: { min_days: 7 } });
  assert.equal(proposals(svc2)[0].p_params.package_ids.length, 20); assert.match(big.card.text, /\+5 ficam para a próxima/);
});

test('cadastros, palavras-chave, convites, moradores e estantes', async () => {
  const svc = fakeSvc();
  const rej = await runIntent(svc, link('intermediate'), { name: 'reject_resident', args: { name: 'maria', reason: 'Não mora no condomínio.' } });
  assert.match(rej.card.text, /recusar cadastro/); assert.match(rej.card.text, /Motivo: Não mora/);
  const kw = await runIntent(svc, link('intermediate'), { name: 'create_keyword', args: { keyword: 'AZUL', block: '02B', unit: '11', carrier: 'Shopee' } });
  assert.match(kw.card.text, /Palavra: AZUL/); assert.match(kw.card.text, /Unidade: 02B 11/);
  const ko = await handleAction(svc, link('intermediate'), 'ko:22222222-2222-4222-8222-222222222222');
  assert.deepEqual(ids(ko), ['kw:22222222-2222-4222-8222-222222222222', 'kc:22222222-2222-4222-8222-222222222222', 'menu']);
  await handleAction(svc, link('intermediate'), 'kc:22222222-2222-4222-8222-222222222222');
  const inv = await handleAction(svc, link('intermediate'), 'invites');
  assert.match(inv.card.text, /Serão enviados: 12/);
  assert.deepEqual(proposals(svc).map((p) => p.p_action), ['reject_resident', 'keyword_create', 'keyword_cancel', 'invite_residents']);
  const who = await runIntent(svc, link('basic'), { name: 'unit_residents', args: { block: '02B', unit: '11' } });
  assert.match(who.card.text, /Maria Silva · ativo/); assert.match(who.card.text, /João · aguardando aprovação/);
  assert.match((await handleAction(svc, link('basic'), 'storage')).card.text, /B2: 5\/10/);
  const find = await runIntent(svc, link('basic'), { name: 'find_package', args: { query: 'ana' } });
  assert.match(find.card.text, /#000000/);
});

test('planilha: só no Avançado e para quem aprova; resumo com contagens; nada gravado antes do ✅', async () => {
  const csv = 'Nome;Bloco;Apto;Celular\nAna Souza;01A;101;(11) 98888-7777\nJosé Lima;02B;11;\nSem Unidade;;;11977776666\n';
  const media = { mimetype: 'text/csv', data: Buffer.from(csv).toString('base64') };
  const svc = fakeSvc();
  const doc = { kind: 'document', mimetype: 'text/csv', fileName: 'moradores.csv' };
  assert.match((await respond(svc, link('intermediate'), doc, media)).card.text, /nível Avançado/);
  assert.match((await handleSheet(svc, link('advanced', { can_approve: false }), media, 'moradores.csv')).card.text, /aprova cadastros/);
  const r = await respond(svc, link('advanced'), doc, media);
  assert.match(r.card.text, /Pessoas válidas: 2 em 2 unidade/); assert.match(r.card.text, /Com WhatsApp: 1/); assert.match(r.card.text, /Sem unidade: 1/);
  const [p] = proposals(svc);
  assert.equal(p.p_action, 'import_residents');
  assert.deepEqual(p.p_params.rows.map((x) => [x.full_name, x.unit_id, x.phone]), [['Ana Souza', 'U1', '+5511988887777'], ['José Lima', 'U2', null]]);
  assert.ok(!svc.calls.some(([fn]) => fn === 'assistant_confirm'));
  const pdf = await respond(svc, link('advanced'), { kind: 'document', mimetype: 'application/pdf', fileName: 'a.pdf' }, { mimetype: 'application/pdf', data: 'AA==' });
  assert.match(pdf.card.text, /\.csv ou \.xlsx/);
});

test('conclusão de lote mostra quantos deram certo e quais falharam', async () => {
  const svc = fakeSvc({ assistant_confirm: () => ({ data: { status: 'done', result: { ok: 1, failed: [{ ref: '000001', error: 'Encomenda não aguarda retirada.' }] } }, error: null }) });
  const r = await handleAction(svc, link('intermediate'), `ok:${PID}`);
  assert.match(r.card.text, /Avisos reenviados: 1/); assert.match(r.card.text, /#000001: Encomenda não aguarda retirada/);
});
