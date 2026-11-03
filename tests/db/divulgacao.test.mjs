// Central de divulgação — 20261103000300: só quem altera configurações lê/grava; validação no banco;
// vazio volta ao padrão; isolamento entre condomínios; tabela sem acesso direto; auditoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('divulgação: permissões, validação, padrão e isolamento', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const [adminA, adminB, porteiro, morador] = await Promise.all([['a@div.invalid', 'Síndica A'], ['b@div.invalid', 'Síndico B'], ['p@div.invalid', 'Porteiro'], ['m@div.invalid', 'Moradora']]
      .map(([e, name]) => db.createUser(e, { name })));
    const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `Cond ${slug}`, p_slug: slug,
      p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
    const A = await prov(adminA, 'div-a', '11444777000161');
    const B = await prov(adminB, 'div-b', '11222333000181');
    const [{ id: unit }] = await db.as(adminA, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [A]);
    for (const [uid, email, role, u] of [[porteiro, 'p@div.invalid', 'porteiro', null], [morador, 'm@div.invalid', 'morador', unit]]) {
      const inv = await db.rpc(adminA, 'create_invitation', { p_tenant: A, p_email: email, p_role: role, p_unit: u, p_permissions: '{}' });
      await db.rpc(uid, 'accept_invitation', { p_token: inv.token });
    }

    // Padrão: nada salvo.
    assert.deepEqual(await db.rpc(adminA, 'divulgacao_get', { p_tenant: A }), {});

    // Salvar personalizado.
    const v = await db.rpc(adminA, 'divulgacao_save', { p_tenant: A, p_model: 'cartaz', p_texts: { title: ' Novidade no condomínio ', body: 'Cadastre-se!' } });
    assert.equal(v.cartaz.title, 'Novidade no condomínio', 'espaços aparados');
    // Campo fora da lista é recusado (nada de gravar chaves arbitrárias).
    await assert.rejects(db.rpc(adminA, 'divulgacao_save', { p_tenant: A, p_model: 'cartaz', p_texts: { title: 'ok', extra: 'campo desconhecido' } }), /inválido/);

    // Validação no banco: HTML, tamanho, modelo, tipo.
    await assert.rejects(db.rpc(adminA, 'divulgacao_save', { p_tenant: A, p_model: 'cartaz', p_texts: { title: '<script>alert(1)</script>' } }), /inválido/);
    await assert.rejects(db.rpc(adminA, 'divulgacao_save', { p_tenant: A, p_model: 'cartaz', p_texts: { title: 'x'.repeat(121) } }), /inválido/);
    await assert.rejects(db.rpc(adminA, 'divulgacao_save', { p_tenant: A, p_model: 'outdoor', p_texts: {} }), /Modelo inválido/);
    await assert.rejects(db.rpc(adminA, 'divulgacao_save', { p_tenant: A, p_model: 'cartaz', p_texts: [] }), /Modelo inválido/);
    assert.equal((await db.rpc(adminA, 'divulgacao_get', { p_tenant: A })).cartaz.title, 'Novidade no condomínio', 'tentativas inválidas não alteram nada');

    // Permissões: porteiro, morador e síndico de outro condomínio não leem nem gravam.
    for (const uid of [porteiro, morador, adminB]) {
      await assert.rejects(db.rpc(uid, 'divulgacao_get', { p_tenant: A }), /Somente/);
      await assert.rejects(db.rpc(uid, 'divulgacao_save', { p_tenant: A, p_model: 'cartaz', p_texts: { title: 'invasão' } }), /Somente/);
    }
    await assert.rejects(db.rpc(null, 'divulgacao_get', { p_tenant: A }), /permission|Somente|denied/i);
    // Tabela sem acesso direto (nem leitura) para usuários.
    await assert.rejects(db.as(adminA, 'select * from portal_divulgacao'), /permission denied/);
    await assert.rejects(db.as(adminA, "update portal_divulgacao set texts = '{}'"), /permission denied/);
    // Isolamento: B não vê A.
    assert.deepEqual(await db.rpc(adminB, 'divulgacao_get', { p_tenant: B }), {});

    // Vazio restaura o padrão.
    const r = await db.rpc(adminA, 'divulgacao_save', { p_tenant: A, p_model: 'cartaz', p_texts: { title: '   ' } });
    assert.equal(r.cartaz, undefined);
    // Auditoria.
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action = 'divulgacao.saved' and tenant_id = $1", [A]))[0].n, 2);
  } finally { await db.raw.close(); }
});
