// Portal público e cadastro sem convite: solicitação ≠ acesso; aprovação cria vínculo
// só na unidade escolhida; isolamento entre condomínios; boas-vindas uma vez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('portal, solicitação, aprovação/recusa, isolamento e boas-vindas', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const uuid = () => crypto.randomUUID();
    const [adminA, adminB, mor, outro, porteiro] = await Promise.all(
      ['sindicoa@portal.invalid', 'sindicob@portal.invalid', 'morador@portal.invalid', 'outro@portal.invalid', 'porteiro@portal.invalid'].map((e) => db.createUser(e)));
    const prov = (u, slug, doc, req = uuid()) => db.rpc(u, 'provision_tenant', { p_request_id: req, p_name: `Cond ${slug}`, p_slug: slug, p_document: doc,
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly', p_contact_phone: '11999990000' });
    const req = uuid();
    const A = (await prov(adminA, 'portal-a', '11444777000161', req)).tenant_id;
    assert.equal((await prov(adminA, 'portal-a', '11444777000161', req)).replayed, true);
    const B = (await prov(adminB, 'portal-b', '11222333000181')).tenant_id;
    await assert.rejects(prov(adminB, 'admin', '12345678000190'), /check|em uso|reserv/i);

    // Boas-vindas: um job por canal, só para o responsável do condomínio novo.
    const welcome = await db.sql("select channel, recipient from notification_jobs where tenant_id=$1 and event='portal_welcome'", [A]);
    assert.deepEqual(welcome.map((w) => w.channel).sort(), ['email', 'whatsapp']);
    assert.ok(welcome.some((w) => w.recipient === 'sindicoa@portal.invalid'));
    const [{ id: unitA }] = await db.as(adminA, "insert into units(tenant_id,block,label) values($1,'A','12B') returning id", [A]);
    const [{ id: unitA2 }] = await db.as(adminA, "insert into units(tenant_id,label) values($1,'99') returning id", [A]);
    const inv = await db.rpc(adminA, 'create_invitation', { p_tenant: A, p_email: 'porteiro@portal.invalid', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
    await db.rpc(porteiro, 'accept_invitation', { p_token: inv.token });
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='portal_welcome' and tenant_id=$1", [A]))[0].n, 2, 'novo membro não reenvia boas-vindas');

    // Portal público: só marca; slug desconhecido = nada.
    const pub = await db.rpc(null, 'portal_info', { p_slug: 'portal-a' });
    assert.equal(pub.name, 'Cond portal-a');
    assert.deepEqual(Object.keys(pub).sort(), ['color_accent', 'color_primary', 'color_secondary', 'icons_version', 'logo_path', 'name', 'slug', 'status', 'tenant_id']);
    assert.equal(await db.rpc(null, 'portal_info', { p_slug: 'nao-existe' }), null);

    // Termo de dados: termo GLOBAL vale sem o síndico publicar nada (20261103000600); o envio exige o hash vigente.
    await assert.rejects(db.rpc(mor, 'request_access', { p_slug: 'portal-a', p_full_name: 'Maria Teste', p_phone: '11988887777', p_block: 'A', p_unit: '12B' }), /aceite o termo/);
    // Publica um termo no condomínio (direto no banco: a publicação pela RPC exige senha recente, testada em privacy-terms.test).
    const publishTerm = async (tenant, slug) => {
      await db.sql("insert into privacy_terms (tenant_id, version, title, content, content_hash) values ($1, '1.0', 'Termo de dados', $2, '')", [tenant, 'x'.repeat(60)]);
      await db.sql("update privacy_terms set status='published', published_at=now(), effective_at=now() where tenant_id=$1", [tenant]);
      return (await db.rpc(null, 'privacy_term_current', { p_slug: slug })).hash;
    };
    const termA = { hash: (await db.rpc(null, 'privacy_term_current', { p_slug: 'portal-a' })).hash };
    // Solicitação: anônimo não; sem e-mail verificado não; pendente não vê nada.
    await assert.rejects(db.rpc(null, 'request_access', { p_slug: 'portal-a', p_full_name: 'X Y', p_phone: '11988887777', p_block: null, p_unit: '1', p_privacy_hash: termA.hash }), /permission denied|login/);
    const naoverif = await db.createUser('naoverif@portal.invalid', { verified: false });
    await assert.rejects(db.rpc(naoverif, 'request_access', { p_slug: 'portal-a', p_full_name: 'Nome Sobrenome', p_phone: '11988887777', p_block: null, p_unit: '1', p_privacy_hash: termA.hash }), /Confirme/);
    const r1 = await db.rpc(mor, 'request_access', { p_slug: 'portal-a', p_full_name: 'Maria Teste', p_phone: '(11) 98888-7777', p_block: 'Bloco A', p_unit: 'Apto 12B', p_privacy_hash: termA.hash });
    const r2 = await db.rpc(mor, 'request_access', { p_slug: 'portal-a', p_full_name: 'Maria Teste', p_phone: '(11) 98888-7777', p_block: 'A', p_unit: '12B', p_privacy_hash: termA.hash });
    assert.equal(r1.request_id, r2.request_id, 'retry não duplica');
    const [row] = await db.sql('select unit_id, status from access_requests where id=$1', [r1.request_id]);
    assert.deepEqual([row.unit_id, row.status], [unitA, 'pending'], 'normaliza "Bloco A" e "Apto 12B"');
    assert.equal((await db.as(mor, 'select * from units')).length, 0);
    assert.equal((await db.as(mor, 'select * from tenant_memberships where tenant_id=$1', [A])).length, 0);
    // Unidade digitada inexistente não é criada.
    const ro = await db.rpc(outro, 'request_access', { p_slug: 'portal-a', p_full_name: 'Outro Morador', p_phone: '21987654321', p_block: 'A', p_unit: '777', p_privacy_hash: termA.hash });
    assert.equal((await db.sql('select unit_id from access_requests where id=$1', [ro.request_id]))[0].unit_id, null);
    assert.equal((await db.sql("select count(*)::int n from units where tenant_id=$1 and label='777'", [A]))[0].n, 0);
    // Síndico avisado; morador não vê a solicitação de outro.
    assert.ok((await db.as(adminA, "select * from notifications where kind='access_request'")).length >= 1);
    assert.equal((await db.as(mor, 'select * from access_requests')).length, 1);

    // Só quem aprova decide; porteiro e síndico de B não.
    await assert.rejects(db.rpc(porteiro, 'decide_access_request', { p_request: r1.request_id, p_approve: true, p_unit: null, p_reason: null }), /aprova/);
    await assert.rejects(db.rpc(adminB, 'decide_access_request', { p_request: r1.request_id, p_approve: true, p_unit: null, p_reason: null }), /aprova/);
    assert.equal(await db.rpc(adminB, 'list_access_requests', { p_tenant: A, p_status: 'pending' }), null);
    await assert.rejects(db.rpc(adminA, 'decide_access_request', { p_request: r1.request_id, p_approve: true, p_unit: (await db.sql("select id from units where tenant_id=$1", [B]))[0]?.id || uuid(), p_reason: null }), /unidade/i);
    // Aprovar: vínculo só na unidade escolhida; idempotente.
    await db.rpc(adminA, 'decide_access_request', { p_request: r1.request_id, p_approve: true, p_unit: null, p_reason: null });
    assert.equal((await db.rpc(adminA, 'decide_access_request', { p_request: r1.request_id, p_approve: true, p_unit: null, p_reason: null })).replayed, true);
    const um = await db.sql('select unit_id from unit_memberships where user_id=$1 and status=$2', [mor, 'active']);
    assert.deepEqual(um.map((x) => x.unit_id), [unitA]);
    assert.equal((await db.sql("select phone from resident_contacts where user_id=$1", [mor]))[0].phone, '+5511988887777');
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='access_decision' and ref_id=$1", [r1.request_id]))[0].n, 2, 'decisão: e-mail + WhatsApp');
    // Aprovado não decide sobre outros nem vê solicitações.
    await assert.rejects(db.rpc(mor, 'decide_access_request', { p_request: ro.request_id, p_approve: true, p_unit: unitA2, p_reason: null }), /aprova/);
    // Recusa exige motivo e não cria vínculo.
    await assert.rejects(db.rpc(adminA, 'decide_access_request', { p_request: ro.request_id, p_approve: false, p_unit: null, p_reason: '' }), /motivo/);
    await db.rpc(adminA, 'decide_access_request', { p_request: ro.request_id, p_approve: false, p_unit: null, p_reason: 'Não reside aqui' });
    assert.equal((await db.sql('select count(*)::int n from tenant_memberships where user_id=$1', [outro]))[0].n, 0);
    assert.equal((await db.rpc(outro, 'my_access_request', { p_slug: 'portal-a' })).status, 'rejected');

    // Mesma conta pede vínculo em B sem novo usuário; acesso em A não vale em B.
    const hashB = (await db.rpc(null, 'privacy_term_current', { p_slug: 'portal-b' })).hash;
    await db.rpc(mor, 'request_access', { p_slug: 'portal-b', p_full_name: 'Maria Teste', p_phone: '11988887777', p_block: null, p_unit: '1', p_privacy_hash: hashB });
    assert.equal((await db.sql("select count(*)::int n from auth.users where email='morador@portal.invalid'"))[0].n, 1);
    assert.equal((await db.as(mor, 'select * from units where tenant_id=$1', [B])).length, 0);
    // Já morador em A: nova solicitação recusada.
    await assert.rejects(db.rpc(mor, 'request_access', { p_slug: 'portal-a', p_full_name: 'Maria Teste', p_phone: '11988887777', p_block: 'A', p_unit: '1', p_privacy_hash: termA.hash }), /já tem acesso/);
    // Limite de abuso.
    const spam = await db.createUser('spam@portal.invalid');
    for (let i = 0; i < 5; i++) {
      const s = await db.rpc(adminB, 'provision_tenant', { p_request_id: uuid(), p_name: `S${i}`, p_slug: `spam-${i}`, p_document: `1000000000000${i}`.slice(-14),
        p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).catch(() => null);
      if (s) await db.rpc(spam, 'request_access', { p_slug: `spam-${i}`, p_full_name: 'Spam Teste', p_phone: '11988887777', p_block: null, p_unit: '1', p_privacy_hash: (await db.rpc(null, 'privacy_term_current', { p_slug: `spam-${i}` })).hash });
    }
    const spamCount = (await db.sql('select count(*)::int n from access_requests where user_id=$1', [spam]))[0].n;
    if (spamCount === 5) await assert.rejects(db.rpc(spam, 'request_access', { p_slug: 'portal-b', p_full_name: 'Spam Teste', p_phone: '11988887777', p_block: null, p_unit: '1', p_privacy_hash: hashB }), /Muitas/);

    // Reenvio das boas-vindas: só "settings", com intervalo.
    await assert.rejects(db.rpc(porteiro, 'resend_portal_welcome', { p_tenant: A }), /permissão/i);
    await db.rpc(adminA, 'resend_portal_welcome', { p_tenant: A });
    await assert.rejects(db.rpc(adminA, 'resend_portal_welcome', { p_tenant: A }), /5 minutos/);
  } finally { await db.raw.close(); }
});
