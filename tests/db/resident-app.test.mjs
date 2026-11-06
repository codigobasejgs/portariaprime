// App do morador: leitura mínima por vínculo ativo, ordem e contagens coerentes,
// comprovante só para quem já morava na entrega, contatos de outros moradores
// protegidos, notificação antiga mostra o estado atual, revogação e pedido encerrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('app do morador: isolamento, estados e contatos', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    db.setNow('2026-03-10T15:00:00Z');
    const uuid = () => crypto.randomUUID();
    const [admin, port, m1, m2, m3, other] = await Promise.all(['sindico@res.invalid', 'porteiro@res.invalid', 'morador-um@res.invalid',
      'morador-dois@res.invalid', 'morador-tres@res.invalid', 'sindico-outro@res.invalid'].map((e) => db.createUser(e)));
    const prov = async (u, slug, doc) => (await db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: slug, p_slug: slug, p_document: doc,
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const T = await prov(admin, 'res-a', '11444777000161');
    const O = await prov(other, 'res-b', '11222333000181');
    const [{ id: u1 }] = await db.as(admin, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [T]);
    const [{ id: u2 }] = await db.as(admin, "insert into units(tenant_id,block,label) values($1,'A','102') returning id", [T]);
    const invite = async (u, email, role, unit) => {
      const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: email, p_role: role, p_unit: unit, p_permissions: '{}' });
      await db.rpc(u, 'accept_invitation', { p_token: inv.token });
    };
    await invite(port, 'porteiro@res.invalid', 'porteiro', null);
    await invite(m1, 'morador-um@res.invalid', 'morador', u1);
    await invite(m2, 'morador-dois@res.invalid', 'morador', u1);
    await invite(m3, 'morador-tres@res.invalid', 'morador', u2);
    await db.sql("update profiles set full_name='Ana Maria Souza' where id=$1", [m1]);
    // Vínculos anteriores às datas simuladas (issued_at usa o relógio do teste).
    await db.sql("update unit_memberships set created_at='2026-01-01' where tenant_id=$1", [T]);
    await db.sql("update resident_contacts set phone='+5511999990001', name='Bruno Lima Costa' where user_id=$1", [m2]);

    // Vazio: contagens zeradas e canais reais.
    const empty = await db.rpc(m1, 'resident_home', { p_tenant: T, p_unit: null });
    assert.deepEqual([empty.waiting.length, empty.recent.length, empty.name], [0, 0, 'Ana Maria Souza']);
    assert.equal(empty.channels.email, true); assert.equal(empty.channels.push_devices, 0);

    // Duas aguardando (mais antiga primeiro), uma pré-registrada invisível, uma de outra unidade.
    const recv = (unit, key, tracking) => db.rpc(port, 'receive_package', { p_tenant: T, p_idempotency_key: key, p_unit: unit, p_tracking: tracking, p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    db.setNow('2026-03-08T12:00:00Z'); const old = await recv(u1, 'res-key-0001', 'BRVELHO');
    db.setNow('2026-03-10T12:00:00Z'); const fresh = await recv(u1, 'res-key-0002', 'BRNOVO');
    const outro = await recv(u2, 'res-key-0003', 'BROUTRA');
    await db.service("insert into packages(tenant_id,unit_id,status,carrier,idempotency_key) values($1,$2,'PRE_REGISTRADA','Totem','res-key-0004')", [T, u1]);
    const home = await db.rpc(m1, 'resident_home', { p_tenant: T, p_unit: null });
    assert.deepEqual(home.waiting.map((p) => p.tracking_code), ['BRVELHO', 'BRNOVO']);
    assert.equal(home.waiting[0].ref, old.id.replace(/-/g, '').slice(0, 6).toUpperCase());
    for (const k of ['storage_location_id', 'storage_code', 'storage_rack', 'notes', 'received_by']) assert.ok(!(k in home.waiting[0]), `não expõe ${k}`);
    // Unidade escolhida que não é do usuário: nada (sem erro, sem vazamento).
    assert.equal((await db.rpc(m1, 'resident_home', { p_tenant: T, p_unit: u2 })).waiting.length, 0);
    await assert.rejects(db.rpc(m1, 'resident_package', { p_tenant: T, p_package: outro.id }), /sem acesso/);
    await assert.rejects(db.rpc(m3, 'resident_package', { p_tenant: T, p_package: old.id }), /sem acesso/);
    await assert.rejects(db.rpc(other, 'resident_home', { p_tenant: T, p_unit: null }), /permissão/i);
    await assert.rejects(db.rpc(port, 'resident_home', { p_tenant: T, p_unit: null }), /permissão/i, 'portaria não usa o app do morador');
    const pre = (await db.sql("select id from packages where idempotency_key='res-key-0004'"))[0].id;
    await assert.rejects(db.rpc(m1, 'resident_package', { p_tenant: T, p_package: pre }), /sem acesso/);

    // Entrega por outro morador da unidade: detalhe atualizado, linha do tempo real, comprovante em processamento.
    db.setNow('2026-03-10T14:00:00Z');
    const sig = `${T}/packages/${old.id}/signature-res00001.png`, photo = `${T}/packages/${old.id}/handover-res00001.jpg`;
    for (const p of [sig, photo]) await db.service("insert into storage.objects (bucket_id,name,owner) values ('tenant-private',$1,$2)", [p, port]);
    await db.rpc(port, 'deliver_package', { p_tenant: T, p_package: old.id, p_request: uuid(), p_qr: null, p_picked_up_by: 'Bruno', p_recipient_kind: 'morador',
      p_signature_path: sig, p_item_photo_path: photo, p_manual_reason: 'Documento conferido na portaria' });
    const det = await db.rpc(m1, 'resident_package', { p_tenant: T, p_package: old.id });
    assert.equal(det.status, 'RETIRADA');
    assert.deepEqual(det.timeline.map((e) => e.kind), ['received', 'picked_up']);
    assert.equal(det.receipt.pdf_status, 'pending');
    await assert.rejects(db.rpc(m1, 'issue_pickup_token', { p_tenant: T, p_package: old.id }), /não está disponível/);
    const h2 = await db.rpc(m1, 'resident_home', { p_tenant: T, p_unit: null });
    assert.deepEqual([h2.waiting.length, h2.recent.length], [1, 1]);

    // Notificação antiga de chegada mostra o estado atual.
    const notes = await db.rpc(m1, 'my_notifications', { p_tenant: T, p_unread: false, p_before: null, p_limit: 20 });
    assert.ok(notes.items.some((n) => n.kind === 'package_received' && n.package_id === old.id && n.package_status === 'RETIRADA'));

    // Histórico: busca por identificador, transportadora e rastreio; filtro por situação.
    const ref = det.ref;
    for (const q of [ref, `#${ref.toLowerCase()}`, 'corr', 'BRVEL']) {
      assert.deepEqual((await db.rpc(m1, 'resident_history', { p_tenant: T, p_search: q })).map((p) => p.id), [old.id], q);
    }
    assert.equal((await db.rpc(m1, 'resident_history', { p_tenant: T, p_status: 'DEVOLVIDA' })).length, 0);
    assert.equal((await db.rpc(m3, 'resident_history', { p_tenant: T })).length, 0);

    // Morador que entrou depois da entrega não vê o comprovante.
    const late = await db.createUser('morador-novo@res.invalid');
    await invite(late, 'morador-novo@res.invalid', 'morador', u1);
    assert.equal((await db.rpc(late, 'resident_package', { p_tenant: T, p_package: old.id })).receipt, null);

    // Contatos: o de outro morador só com primeiro nome e canais; não lê nem altera pela tabela.
    const prof = await db.rpc(m1, 'resident_profile', { p_tenant: T });
    const bruno = prof.contacts.find((c) => c.name === 'Bruno');
    assert.deepEqual([bruno.editable, bruno.has_whatsapp, 'phone' in bruno, 'email' in bruno], [false, true, false, false]);
    assert.ok(prof.contacts.some((c) => c.mine && c.editable));
    assert.equal((await db.as(m1, 'select * from resident_contacts where user_id=$1', [m2])).length, 0);
    await db.as(m1, 'update resident_contacts set notify_whatsapp=false where user_id=$1', [m2]);
    assert.equal((await db.sql('select notify_whatsapp from resident_contacts where user_id=$1', [m2]))[0].notify_whatsapp, true);
    // Familiar sem conta continua gerenciável pela unidade.
    await db.as(m1, "insert into resident_contacts(tenant_id,unit_id,name,email) values($1,$2,'Avó Teste','avo@res.invalid')", [T, u1]);
    assert.ok((await db.rpc(m2, 'resident_profile', { p_tenant: T })).contacts.some((c) => c.name === 'Avó Teste' && c.editable));

    // Revogado: perde tudo na hora; pedido de acesso antigo aparece como encerrado.
    await db.sql("insert into access_requests(tenant_id,user_id,full_name,unit_text,status) values($1,$2,'Três','102','approved')", [T, m3]);
    const [{ id: mem }] = await db.sql("select id from tenant_memberships where tenant_id=$1 and user_id=$2 and role='morador'", [T, m3]);
    await db.sql("update tenant_memberships set status='revoked' where id=$1", [mem]);
    await assert.rejects(db.rpc(m3, 'resident_home', { p_tenant: T, p_unit: null }), /permissão/i);
    assert.equal((await db.rpc(m3, 'my_access_request', { p_slug: 'res-a' })).status, 'revoked');
    assert.equal((await db.rpc(m1, 'my_access_request', { p_slug: 'res-b' })), null);
    void O;
  } finally { await db.raw.close(); }
});
