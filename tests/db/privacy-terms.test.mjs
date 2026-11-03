// Termo de ciência e aceite (dados pessoais) no cadastro do morador — 20261103000100.
// Versionamento imutável, aceite com hora do servidor e versão resolvida no servidor, bloqueio do
// envio sem aceite, aprovação exige aceite, isolamento entre condomínios e permissões.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const TEXT = 'Declaro que sou morador efetivo do condomínio e estou ciente do tratamento dos meus dados.';

test('termo LGPD: versões, aceite obrigatório no servidor, aprovação e isolamento', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const [adminA, adminB, mor, mor2, porteiro] = await Promise.all(
      ['a@lgpd.invalid', 'b@lgpd.invalid', 'mor@lgpd.invalid', 'mor2@lgpd.invalid', 'port@lgpd.invalid'].map((e) => db.createUser(e)));
    const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `Cond ${slug}`, p_slug: slug,
      p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
    const A = await prov(adminA, 'lgpd-a', '11444777000161');
    const B = await prov(adminB, 'lgpd-b', '11222333000181');
    const [{ id: unit }] = await db.as(adminA, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [A]);
    const inv = await db.rpc(adminA, 'create_invitation', { p_tenant: A, p_email: 'port@lgpd.invalid', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
    await db.rpc(porteiro, 'accept_invitation', { p_token: inv.token });
    // Senha recente simulada (a publicação exige reautenticação).
    const fresh = (uid) => db.as(uid, `select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
    const asFresh = async (uid, fn, args) => {
      const keys = Object.keys(args);
      await db.raw.exec('begin');
      try {
        await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
        await db.raw.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
        await db.raw.exec('set local role authenticated');
        const r = await db.raw.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
        await db.raw.exec('commit');
        return r.rows[0].r;
      } catch (e) { await db.raw.exec('rollback'); throw e; }
    };
    void fresh;
    const send = (uid, slug, hash) => db.rpc(uid, 'request_access', { p_slug: slug, p_full_name: 'Maria Moradora', p_phone: '11988887777', p_block: 'A', p_unit: '101', p_privacy_hash: hash });

    // 1) Sem termo do condomínio vale o GLOBAL da plataforma (20261103000600); o envio exige o hash dele.
    const g = await db.rpc(null, 'privacy_term_current', { p_slug: 'lgpd-a' });
    assert.equal(g.scope, 'global');
    await assert.rejects(send(mor, 'lgpd-a', 'qualquer'), /aceite o termo/);
    await assert.rejects(db.rpc(mor, 'request_access', { p_slug: 'lgpd-a', p_full_name: 'Maria Moradora', p_phone: '11988887777', p_block: 'A', p_unit: '101' }), /aceite o termo/,
      'assinatura antiga (app em cache, sem hash) é barrada');

    // 2) Permissões: porteiro e morador não editam; síndico de B não edita A; rascunho editável.
    await assert.rejects(db.rpc(porteiro, 'privacy_term_save', { p_tenant: A, p_id: null, p_version: '1.0', p_title: 'Termo', p_content: TEXT, p_note: null }), /Somente/);
    await assert.rejects(db.rpc(adminB, 'privacy_term_save', { p_tenant: A, p_id: null, p_version: '1.0', p_title: 'Termo', p_content: TEXT, p_note: null }), /Somente/);
    const d1 = await db.rpc(adminA, 'privacy_term_save', { p_tenant: A, p_id: null, p_version: '1.0', p_title: 'Termo de dados', p_content: TEXT, p_note: null });
    await db.rpc(adminA, 'privacy_term_save', { p_tenant: A, p_id: d1.id, p_version: '1.0', p_title: 'Termo de dados', p_content: TEXT + ' Revisado.', p_note: 'ajuste' });
    await assert.rejects(db.rpc(adminA, 'privacy_term_save', { p_tenant: A, p_id: null, p_version: 'x y', p_title: 'T', p_content: 'curto', p_note: null }), /inválido/);

    // 3) Publicação exige senha recente; publicado fica imutável.
    await assert.rejects(db.rpc(adminA, 'privacy_term_publish', { p_tenant: A, p_id: d1.id }), /Confirme sua senha/);
    const pub1 = await asFresh(adminA, 'privacy_term_publish', { p_tenant: A, p_id: d1.id });
    assert.equal(pub1.version, '1.0');
    await assert.rejects(db.sql("update privacy_terms set content = 'mudado depois de publicado e com tamanho suficiente para passar no check' where id=$1", [d1.id]), /imutável/);
    await assert.rejects(db.sql('delete from privacy_terms where id=$1', [d1.id]), /não pode ser apagada/);
    const cur = await db.rpc(null, 'privacy_term_current', { p_slug: 'lgpd-a' });
    assert.equal(cur.version, '1.0');
    assert.equal(cur.scope, 'tenant', 'termo do condomínio prevalece sobre o global');
    const curB = await db.rpc(null, 'privacy_term_current', { p_slug: 'lgpd-b' });
    assert.equal(curB.scope, 'global', 'termo de A não aparece em B (B segue no global)');
    assert.ok(!curB.content.includes(TEXT));

    // 4) Envio: hash errado/ausente recusado (sem pedido criado); hash certo grava pedido + aceite na mesma transação.
    await assert.rejects(send(mor, 'lgpd-a', null), /aceite o termo/);
    await assert.rejects(send(mor, 'lgpd-a', 'f'.repeat(64)), /aceite o termo/);
    assert.equal((await db.sql('select count(*)::int n from access_requests where user_id=$1', [mor]))[0].n, 0, 'nada gravado sem aceite');
    db.setNow('2026-11-03T15:00:00Z');
    const r = await send(mor, 'lgpd-a', cur.hash);
    assert.equal(r.privacy_version, '1.0');
    const [ack] = await db.sql('select * from privacy_acknowledgements where user_id=$1', [mor]);
    assert.equal(ack.access_request_id, r.request_id);
    assert.equal(ack.term_version, '1.0');
    assert.equal(ack.term_hash, cur.hash);
    assert.equal(new Date(ack.accepted_at).toISOString(), '2026-11-03T15:00:00.000Z', 'hora do servidor (relógio de teste), não do navegador');
    assert.equal(ack.action_source, 'cadastro_portal');
    // Reenvio não duplica o aceite.
    await send(mor, 'lgpd-a', cur.hash);
    assert.equal((await db.sql('select count(*)::int n from privacy_acknowledgements where user_id=$1', [mor]))[0].n, 1);
    // Aceite é permanente.
    await assert.rejects(db.sql('update privacy_acknowledgements set term_version = $1 where id = $2', ['9.9', ack.id]), /permanente/);
    await assert.rejects(db.sql('delete from privacy_acknowledgements where id = $1', [ack.id]), /permanente/);

    // 5) Fila do síndico mostra versão aceita; morador não lê aceite de outro; síndico de B não lê A.
    const list = await db.rpc(adminA, 'list_access_requests', { p_tenant: A, p_status: 'pending' });
    assert.equal(list[0].privacy_version, '1.0');
    assert.ok(list[0].privacy_accepted_at);
    const acks = await db.rpc(adminA, 'privacy_acknowledgements_list', { p_tenant: A, p_limit: 10, p_offset: 0 });
    assert.equal(acks.total, 1);
    assert.equal(acks.rows[0].full_name, 'Maria Moradora');
    await assert.rejects(db.rpc(adminB, 'privacy_acknowledgements_list', { p_tenant: A, p_limit: 10, p_offset: 0 }), /Somente/);
    await assert.rejects(db.rpc(porteiro, 'privacy_acknowledgements_list', { p_tenant: A, p_limit: 10, p_offset: 0 }), /Somente/);
    assert.equal((await db.as(mor2, 'select * from privacy_acknowledgements')).length, 0);
    assert.equal((await db.as(adminB, 'select * from privacy_acknowledgements')).length, 0);
    assert.equal((await db.as(mor, 'select * from privacy_acknowledgements')).length, 1, 'morador vê o próprio aceite');

    // 6) Aprovação: com aceite, aprova; pedido sem aceite (criado depois da publicação, por fora) é barrado.
    const ok = await db.rpc(adminA, 'decide_access_request', { p_request: r.request_id, p_approve: true, p_unit: unit, p_reason: null });
    assert.equal(ok.status, 'approved');
    const [{ id: semAceite }] = await db.sql("insert into access_requests (tenant_id, user_id, full_name, unit_text) values ($1, $2, 'Sem Aceite', '101') returning id", [A, mor2]);
    await assert.rejects(db.rpc(adminA, 'decide_access_request', { p_request: semAceite, p_approve: true, p_unit: unit, p_reason: null }), /não tem o aceite/);
    // Recusar continua possível sem aceite.
    assert.equal((await db.rpc(adminA, 'decide_access_request', { p_request: semAceite, p_approve: false, p_unit: null, p_reason: 'Sem aceite do termo' })).status, 'rejected');

    // 7) Nova versão: a anterior é preservada (arquivada, com aceites); só uma publicada.
    const d2 = await db.rpc(adminA, 'privacy_term_save', { p_tenant: A, p_id: null, p_version: '1.1', p_title: 'Termo de dados', p_content: TEXT + ' Versão 1.1.', p_note: 'novo canal' });
    const pub2 = await asFresh(adminA, 'privacy_term_publish', { p_tenant: A, p_id: d2.id });
    assert.equal(pub2.previous_id, d1.id);
    const versions = await db.rpc(adminA, 'privacy_terms_admin', { p_tenant: A });
    assert.deepEqual(versions.versions.map((v) => `${v.version}:${v.status}:${v.acknowledgements}`).sort(), ['1.0:archived:1', '1.1:published:0']);
    // Hash da versão antiga não vale mais para novo cadastro.
    await assert.rejects(send(mor2, 'lgpd-a', cur.hash), /aceite o termo/);
    const cur2 = await db.rpc(null, 'privacy_term_current', { p_slug: 'lgpd-a' });
    const r2 = await send(mor2, 'lgpd-a', cur2.hash);
    assert.equal(r2.privacy_version, '1.1');
    // Auditoria da publicação.
    assert.ok((await db.sql("select count(*)::int n from audit_logs where action='privacy_term.published' and tenant_id=$1", [A]))[0].n === 2);
  } finally { await db.raw.close(); }
});
