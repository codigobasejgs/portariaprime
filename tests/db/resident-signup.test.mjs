// Cadastro do morador — 20261103000600: termo GLOBAL (sem publicação do síndico), cadastro em uma etapa com
// rascunho capturado no signUp, avisos persistidos (síndico e morador), aprovação/recusa com e-mail e WhatsApp,
// validações, idempotência, concorrência e isolamento entre condomínios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('cadastro do morador: termo global, uma etapa, avisos e isolamento', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const user = (e, name, meta) => meta
      ? db.sql(`insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id`, [e, JSON.stringify({ full_name: name, pp_signup: meta })]).then((r) => r[0].id)
      : db.createUser(e, { name });
    const [admA, admB] = await Promise.all([user('a@res.invalid', 'Síndica A'), user('b@res.invalid', 'Síndico B')]);
    const prov = (u, slug, doc, name) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: name, p_slug: slug,
      p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
    const A = await prov(admA, 'aurora', '11444777000161', 'Residencial Aurora');
    const B = await prov(admB, 'boreal', '11222333000181', 'Condomínio Boreal');
    await db.as(admA, "insert into units(tenant_id,block,label) values ($1,'A','101'),($1,'A','102'),($1,'B','201')", [A]);
    await db.as(admB, "insert into units(tenant_id,label) values ($1,'1'),($1,'2')", [B]);
    const jobs = (event) => db.sql('select channel, recipient, status from notification_jobs where event = $1 order by channel', [event]);

    // 1) Termo global disponível SEM o síndico publicar nada, com o nome do próprio condomínio.
    const tA = await db.rpc(null, 'privacy_term_current', { p_slug: 'aurora' });
    const tB = await db.rpc(null, 'privacy_term_current', { p_slug: 'boreal' });
    assert.equal(tA.scope, 'global');
    assert.equal(tA.version, '1.0');
    assert.match(tA.content, /morador efetivo do Residencial Aurora/);
    assert.ok(!/\{\{CONDOMINIO\}\}/.test(tA.content), 'placeholder substituído');
    assert.match(tB.content, /Condomínio Boreal/);
    assert.ok(!tB.content.includes('Aurora'), 'termo de B não tem dados de A');
    assert.notEqual(tA.hash, tB.hash, 'hash é do texto exibido (com o nome)');
    assert.equal(tA.template_hash, undefined, 'hash do modelo não é exposto ao público');
    assert.equal((await db.sql('select count(*)::int n from privacy_terms_global'))[0].n, 1, 'uma versão global para todos (não uma por condomínio)');

    // 2) Seletor público de unidades: só rótulos do próprio condomínio.
    const uA = await db.rpc(null, 'portal_units', { p_slug: 'aurora' });
    assert.equal(uA.has_blocks, true);
    assert.deepEqual(uA.units.map((u) => `${u.block}-${u.label}`), ['A-101', 'A-102', 'B-201']);
    const uB = await db.rpc(null, 'portal_units', { p_slug: 'boreal' });
    assert.equal(uB.has_blocks, false);
    assert.equal(uB.units.length, 2);
    assert.equal(await db.rpc(null, 'portal_units', { p_slug: 'nao-existe' }), null);

    // 3) Cadastro em UMA etapa: o signUp leva os dados; o servidor guarda o rascunho (sem sessão ainda).
    const ana = await user('ana@res.invalid', 'Ana Souza', { slug: 'aurora', full_name: 'Ana Souza', phone: '(11) 98888-7777', block: 'A', unit: '101', privacy_hash: tA.hash });
    const [draft] = await db.sql('select phone, block_text, unit_text from resident_signup_drafts where user_id = $1', [ana]);
    assert.deepEqual([draft.phone, draft.block_text, draft.unit_text], ['+5511988887777', 'A', '101'], 'telefone em E.164');
    assert.equal((await db.rpc(ana, 'my_access_request', { p_slug: 'aurora' })).status, 'draft');
    // Primeiro login: finaliza sem pedir nada de novo.
    const fin = await db.rpc(ana, 'resident_signup_finalize', {});
    assert.equal(fin.status, 'created');
    assert.equal(fin.privacy_version, '1.0');
    assert.equal((await db.rpc(ana, 'resident_signup_finalize', {})).status, 'none', 'idempotente: segunda chamada não cria nada');
    const mine = await db.rpc(ana, 'my_access_request', { p_slug: 'aurora' });
    assert.deepEqual([mine.status, mine.full_name, mine.unit_text, mine.privacy_version], ['pending', 'Ana Souza', 'A 101', '1.0']);
    // Aceite: versão, hash do modelo, hash do texto exibido, nome exibido, hora do servidor.
    const [ack] = await db.sql('select * from privacy_acknowledgements where user_id = $1', [ana]);
    assert.equal(ack.term_version, '1.0');
    assert.equal(ack.displayed_text_hash, tA.hash);
    assert.equal(ack.tenant_name_shown, 'Residencial Aurora');
    assert.ok(ack.global_term_id && !ack.privacy_term_id);
    assert.equal(ack.access_request_id, fin.request_id);

    // 4) Avisos persistidos: síndico (central + push + e-mail) e morador (e-mail + WhatsApp).
    assert.equal((await db.sql("select count(*)::int n from notifications where tenant_id = $1 and kind = 'access_request'", [A]))[0].n, 1);
    assert.deepEqual((await jobs('access_request')).map((j) => j.channel), ['email', 'push']);
    const rec = await jobs('access_received');
    assert.deepEqual(rec.map((j) => [j.channel, j.recipient]), [['email', 'ana@res.invalid'], ['whatsapp', '+5511988887777']]);
    // Regras de envio: só o próprio solicitante.
    const allowed = await db.sql("select event, channel, app.notification_allowed(j) ok from notification_jobs j where event in ('access_request','access_received') order by 1, 2");
    assert.deepEqual(allowed.map((r) => `${r.event}:${r.channel}:${r.ok}`),
      ['access_received:email:true', 'access_received:whatsapp:true', 'access_request:email:true', 'access_request:push:true'], 'destinatários legítimos autorizados');
    // Destinatário forjado: a trava de inserção (app.guard_notification_recipient) descarta o aviso.
    const forged = await db.sql("insert into notification_jobs (tenant_id, event, channel, recipient, ref_id) values ($1, 'access_received', 'email', 'intruso@x.invalid', $2) returning id", [A, fin.request_id]);
    assert.equal(forged.length, 0, 'destinatário forjado barrado na inserção');
    const forgedWa = await db.sql("insert into notification_jobs (tenant_id, event, channel, recipient, ref_id) values ($1, 'access_received', 'whatsapp', '+5511900000000', $2) returning id", [B, fin.request_id]);
    assert.equal(forgedWa.length, 0, 'pedido de A não gera aviso em nome de B');
    // Contexto do template: primeiro nome e unidade, sem e-mail/telefone.
    const [{ id: recEmail }] = await db.sql("select id from notification_jobs where event = 'access_received' and channel = 'email'");
    const ctx = (await db.sql('select public.notification_context($1) c', [recEmail]))[0].c;
    assert.deepEqual(ctx.resident, { name: 'Ana', unit: 'A 101', reason: null });

    // 5) Fila do síndico: e-mail verificado, versão do termo, contador.
    const q = await db.rpc(admA, 'list_access_requests', { p_tenant: A, p_status: 'pending' });
    assert.equal(q.length, 1);
    assert.deepEqual([q[0].full_name, q[0].phone, q[0].block_text, q[0].unit_text, q[0].email_verified, q[0].privacy_version], ['Ana Souza', '+5511988887777', 'A', '101', true, '1.0']);
    assert.equal(await db.rpc(admA, 'access_requests_pending_count', { p_tenant: A }), 1);
    assert.equal(await db.rpc(admB, 'access_requests_pending_count', { p_tenant: A }), 0, 'síndico de B não conta A');
    assert.equal(await db.rpc(admB, 'list_access_requests', { p_tenant: A, p_status: 'pending' }), null, 'síndico de B não vê fila de A');

    // 6) Aprovar: vínculo, unidade, boas-vindas por e-mail e WhatsApp; aprovação repetida não duplica.
    const [{ id: a101 }] = await db.sql("select id from units where tenant_id = $1 and label = '101'", [A]);
    const ok = await db.rpc(admA, 'decide_access_request', { p_request: fin.request_id, p_approve: true, p_unit: null, p_reason: null });
    assert.equal(ok.status, 'approved');
    const again = await db.rpc(admA, 'decide_access_request', { p_request: fin.request_id, p_approve: false, p_unit: null, p_reason: 'tarde demais' });
    assert.equal(again.replayed, true, 'decisão concorrente/repetida não muda o estado');
    assert.equal((await db.sql("select status from access_requests where id = $1", [fin.request_id]))[0].status, 'approved');
    assert.equal((await db.sql("select count(*)::int n from tenant_memberships where tenant_id=$1 and user_id=$2 and role='morador' and status='active'", [A, ana]))[0].n, 1);
    assert.equal((await db.sql("select unit_id from unit_memberships where user_id=$1", [ana]))[0].unit_id, a101);
    assert.deepEqual((await jobs('access_decision')).map((j) => [j.channel, j.recipient]), [['email', 'ana@res.invalid'], ['whatsapp', '+5511988887777']]);
    assert.equal((await db.rpc(ana, 'my_access_request', { p_slug: 'aurora' })).status, 'approved');

    // 7) Casos negativos (cada um sem gravar nada).
    const bia = await user('bia@res.invalid', 'Bia Lima');
    const send = (over = {}) => db.rpc(bia, 'request_access', { p_slug: 'aurora', p_full_name: 'Bia Lima', p_phone: '11 97777-6666', p_block: 'A', p_unit: '102', p_privacy_hash: tA.hash, ...over });
    await assert.rejects(send({ p_full_name: 'Bia' }), /nome completo/);
    await assert.rejects(send({ p_phone: null }), /celular com DDD/);
    await assert.rejects(send({ p_phone: '1234' }), /Celular inválido/);
    // Campo é celular/WhatsApp: fixo (8 dígitos após o DDD) e DDD inexistente recusados.
    await assert.rejects(send({ p_phone: '11 3333-4444' }), /Celular inválido/);
    await assert.rejects(send({ p_phone: '09 99999-8888' }), /Celular inválido/);
    await assert.rejects(send({ p_block: '' }), /bloco ou torre/);
    await assert.rejects(send({ p_unit: ' ' }), /unidade/);
    await assert.rejects(send({ p_privacy_hash: null }), /aceite o termo/);
    await assert.rejects(send({ p_privacy_hash: tB.hash }), /aceite o termo/, 'hash do termo de OUTRO condomínio não vale');
    assert.equal((await db.sql('select count(*)::int n from access_requests where user_id = $1', [bia]))[0].n, 0, 'nada gravado nas tentativas inválidas');
    // Clique duplo / reenvio: uma pendente só.
    const r1 = await send(); const r2 = await send({ p_unit: '102' });
    assert.equal(r1.request_id, r2.request_id);
    assert.equal(r2.created, false);
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='access_received' and ref_id=$1", [r1.request_id]))[0].n, 2, 'avisos não duplicam no reenvio');
    // Unidade inexistente: pedido fica para análise (sem criar unidade); aprovar exige escolher uma.
    const caio = await user('caio@res.invalid', 'Caio Prado');
    const rc = await db.rpc(caio, 'request_access', { p_slug: 'aurora', p_full_name: 'Caio Prado', p_phone: '21987654321', p_block: 'Z', p_unit: '999', p_privacy_hash: tA.hash });
    assert.equal((await db.sql('select unit_id from access_requests where id = $1', [rc.request_id]))[0].unit_id, null);
    assert.equal((await db.sql("select count(*)::int n from units where tenant_id = $1 and label = '999'", [A]))[0].n, 0, 'unidade não criada sozinha');
    await assert.rejects(db.rpc(admA, 'decide_access_request', { p_request: rc.request_id, p_approve: true, p_unit: null, p_reason: null }), /Escolha uma unidade/);
    // Unidade de outro condomínio no aprovar: recusado.
    const [{ id: b1 }] = await db.sql("select id from units where tenant_id = $1 and label = '1'", [B]);
    await assert.rejects(db.rpc(admA, 'decide_access_request', { p_request: rc.request_id, p_approve: true, p_unit: b1, p_reason: null }), /Escolha uma unidade/);
    // Recusa com motivo, e-mail + WhatsApp.
    const rj = await db.rpc(admA, 'decide_access_request', { p_request: rc.request_id, p_approve: false, p_unit: null, p_reason: 'Unidade não identificada' });
    assert.equal(rj.status, 'rejected');
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='access_decision' and ref_id=$1", [rc.request_id]))[0].n, 2);
    // Síndico de B não decide pedido de A.
    await assert.rejects(db.rpc(admB, 'decide_access_request', { p_request: r1.request_id, p_approve: true, p_unit: null, p_reason: null }), /Somente/);
    // Pendente não lê dados do condomínio.
    await assert.rejects(db.rpc(bia, 'resident_home', { p_tenant: A, p_unit: null }), /permiss/i);
    // Condomínio sem blocos: bloco não é exigido.
    const dan = await user('dan@res.invalid', 'Dan Rocha');
    const rd = await db.rpc(dan, 'request_access', { p_slug: 'boreal', p_full_name: 'Dan Rocha', p_phone: '31991234567', p_block: '', p_unit: '2', p_privacy_hash: tB.hash });
    assert.ok(rd.request_id);
    assert.equal((await db.rpc(admA, 'list_access_requests', { p_tenant: A, p_status: null })).some((r) => r.full_name === 'Dan Rocha'), false, 'filas não se misturam');

    // 8) Rascunho com termo que mudou: finalize devolve o que revisar, sem perder os dados.
    const eva = await user('eva@res.invalid', 'Eva Melo', { slug: 'aurora', full_name: 'Eva Melo', phone: '11966665555', block: 'B', unit: '201', privacy_hash: 'hash-antigo' });
    const rev = await db.rpc(eva, 'resident_signup_finalize', {});
    assert.equal(rev.status, 'needs_review');
    assert.deepEqual([rev.draft.full_name, rev.draft.unit], ['Eva Melo', '201']);
    assert.equal((await db.sql('select count(*)::int n from access_requests where user_id = $1', [eva]))[0].n, 0);
    // Revisou e enviou pela tela: o rascunho deixa de valer (recusa depois não recria o pedido sozinha).
    const tEva = await db.rpc(null, 'privacy_term_current', { p_slug: 'aurora' });
    await db.rpc(eva, 'request_access', { p_slug: 'aurora', p_full_name: 'Eva Melo', p_phone: '11966665555', p_block: 'B', p_unit: '201', p_privacy_hash: tEva.hash });
    assert.equal((await db.sql('select count(*)::int n from resident_signup_drafts where user_id = $1', [eva]))[0].n, 0);
    assert.equal((await db.rpc(eva, 'resident_signup_finalize', {})).status, 'none');
    // Metadata inválido (telefone ruim) não impede criar a conta.
    const fe = await user('fe@res.invalid', 'Fe Dias', { slug: 'aurora', full_name: 'Fe Dias', phone: '12', unit: '101' });
    assert.ok(fe);
    assert.equal((await db.sql('select count(*)::int n from resident_signup_drafts where user_id = $1', [fe]))[0].n, 0);

    // 9) Termo do condomínio (opcional) prevalece sobre o global, sem tocar nos aceites antigos.
    const before = (await db.sql('select count(*)::int n from privacy_acknowledgements where global_term_id is not null'))[0].n;
    await db.sql("insert into privacy_terms (tenant_id, version, title, content, content_hash, status, published_at) values ($1, '2.0', 'Termo Aurora', $2, '', 'published', now())", [A, 'Texto próprio do condomínio Aurora com pelo menos cinquenta caracteres.']);
    assert.equal((await db.rpc(null, 'privacy_term_current', { p_slug: 'aurora' })).scope, 'tenant');
    assert.equal((await db.rpc(null, 'privacy_term_current', { p_slug: 'boreal' })).scope, 'global', 'B continua no global');
    assert.equal((await db.sql('select count(*)::int n from privacy_acknowledgements where global_term_id is not null'))[0].n, before, 'aceites antigos intactos');
    // Termo global publicado é imutável.
    await assert.rejects(db.sql("update privacy_terms_global set content = content || ' x'"), /imutável/);
    await assert.rejects(db.sql('delete from privacy_terms_global'), /não pode ser apagada/);
    // Gestão global só pela plataforma.
    await assert.rejects(db.rpc(admA, 'platform_privacy_term_save', { p_id: null, p_version: '9', p_title: 'x', p_content: 'x'.repeat(60), p_note: null }), /plataforma/);
    await assert.rejects(db.rpc(admA, 'platform_privacy_terms', {}), /plataforma/);
  } finally { await db.raw.close(); }
});
