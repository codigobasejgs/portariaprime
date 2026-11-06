// Galeria de recebimento: até 8 fotos em ordem, dono do objeto, prefixo do
// tenant/pacote, retry idempotente, morador da unidade lê, outro tenant não.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('galeria: limite de 8, posição, dono, prefixo, retry e leitura por unidade', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const uuid = () => crypto.randomUUID();
    const [admin, adminB, port, mor, outro] = await Promise.all(['sindico@gal.invalid', 'sindicob@gal.invalid', 'porteiro@gal.invalid', 'morador@gal.invalid', 'outro@gal.invalid'].map((e) => db.createUser(e)));
    const prov = async (u, slug, doc) => (await db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: slug, p_slug: slug, p_document: doc,
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const A = await prov(admin, 'gal-a', '11444777000161');
    const B = await prov(adminB, 'gal-b', '11222333000181');
    const [{ id: unit }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'101') returning id", [A]);
    const [{ id: unit2 }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'102') returning id", [A]);
    for (const [u, email, role, un] of [[port, 'porteiro@gal.invalid', 'porteiro', null], [mor, 'morador@gal.invalid', 'morador', unit], [outro, 'outro@gal.invalid', 'morador', unit2]]) {
      const inv = await db.rpc(admin, 'create_invitation', { p_tenant: A, p_email: email, p_role: role, p_unit: un, p_permissions: '{}' });
      await db.rpc(u, 'accept_invitation', { p_token: inv.token });
    }
    const pkg = await db.rpc(port, 'receive_package', { p_tenant: A, p_idempotency_key: 'gal-key-0001', p_unit: unit, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    const pkg2 = await db.rpc(port, 'receive_package', { p_tenant: A, p_idempotency_key: 'gal-key-0002', p_unit: unit, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    const path = (n, tag, p = pkg.id, t = A) => `${t}/packages/${p}/label-${n}-${tag}abcdef12.jpg`;
    const store = (p, owner, metadata = { mimetype: 'image/jpeg', size: 1000 }) => db.service("insert into storage.objects (bucket_id,name,owner,metadata) values ('tenant-private',$1,$2,$3)", [p, owner, JSON.stringify(metadata)]);
    const attach = (p, u = port, pk = pkg.id, t = A) => db.rpc(u, 'attach_label_photo', { p_tenant: t, p_package: pk, p_path: p });

    // 8 fotos em posições 1..8 (ordem do cliente, não da chegada).
    for (const n of [3, 1, 2, 4, 5, 6, 7, 8]) { await store(path(n, 'x'), port); assert.equal((await attach(path(n, 'x'))).position, n); }
    // Retry da mesma foto e da mesma posição com outro arquivo: devolve o vínculo existente.
    assert.equal((await attach(path(3, 'x'))).replayed, true);
    await store(path(3, 'y'), port);
    assert.equal((await attach(path(3, 'y'))).replayed, true);
    // Nona foto (caminho antigo sem posição) é recusada.
    const legacy = `${A}/packages/${pkg.id}/label_photo-legacy0001.jpg`;
    await store(legacy, port);
    await assert.rejects(attach(legacy), /Limite de 8/);
    await assert.rejects(db.rpc(port, 'attach_package_file', { p_tenant: A, p_package: pkg.id, p_kind: 'label_photo', p_path: legacy }), /Limite de 8/);
    const rows = await db.sql("select position from package_attachments where package_id=$1 and kind='label_photo' order by position", [pkg.id]);
    assert.deepEqual(rows.map((r) => r.position), [1, 2, 3, 4, 5, 6, 7, 8]);

    // Caminho antigo continua aceito (primeira posição livre).
    const old = `${A}/packages/${pkg2.id}/label_photo-legacy0002.jpg`;
    await store(old, port);
    assert.equal((await db.sql("select position from package_attachments where id = $1",
      [await db.rpc(port, 'attach_package_file', { p_tenant: A, p_package: pkg2.id, p_kind: 'label_photo', p_path: old })]))[0].position, 1);

    // Dono do objeto: arquivo enviado por outra pessoa não é vinculado.
    await store(path(2, 'z', pkg2.id), admin);
    await assert.rejects(attach(path(2, 'z', pkg2.id), port, pkg2.id), /não foi enviado/);
    // Prefixo: pacote/tenant errado, posição fora de 1..8, extensão inválida.
    await store(path(3, 'w', pkg2.id), port);
    await assert.rejects(attach(path(3, 'w', pkg2.id)), /Arquivo inválido/);
    for (const bad of [`${A}/packages/${pkg2.id}/label-9-abcdef1234.jpg`, `${A}/packages/${pkg2.id}/label-1-abcdef1234.gif`, `${B}/packages/${pkg2.id}/label-1-abcdef1234.jpg`]) {
      await assert.rejects(attach(bad, port, pkg2.id), /Arquivo inválido/);
    }
    // MIME e tamanho registrados pelo Storage também são conferidos no vínculo.
    for (const [tag, metadata] of [['big', { mimetype: 'image/jpeg', size: 5242881 }], ['html', { mimetype: 'text/html', size: 100 }], ['empty', {}]]) {
      const bad = path(2, tag, pkg2.id);
      await store(bad, port, metadata);
      await assert.rejects(attach(bad, port, pkg2.id), /JPEG de até 5 MB/);
    }
    // Outro condomínio e morador não vinculam.
    await assert.rejects(attach(path(4, 'q', pkg2.id), adminB, pkg2.id), /permissão/i);
    await assert.rejects(attach(path(4, 'q', pkg2.id), mor, pkg2.id), /permissão/i);
    await assert.rejects(db.rpc(null, 'attach_label_photo', { p_tenant: A, p_package: pkg2.id, p_path: path(4, 'q', pkg2.id) }), /permission denied/);

    // Leitura: morador da unidade vê as fotos; morador de outra unidade e outro tenant não.
    assert.equal((await db.as(mor, "select id from package_attachments where package_id=$1 and kind='label_photo'", [pkg.id])).length, 8);
    assert.equal((await db.as(outro, "select id from package_attachments where package_id=$1", [pkg.id])).length, 0);
    assert.equal((await db.as(adminB, "select id from package_attachments where package_id=$1", [pkg.id])).length, 0);

    // Foto da entrega segue separada (handover) e não conta na galeria.
    const sig = `${A}/packages/${pkg.id}/signature-sig00001.png`, hand = `${A}/packages/${pkg.id}/handover-han00001.jpg`;
    await store(sig, port); await store(hand, port);
    await db.rpc(port, 'deliver_package', { p_tenant: A, p_package: pkg.id, p_request: uuid(), p_qr: null, p_picked_up_by: 'Pessoa',
      p_recipient_kind: 'morador', p_signature_path: sig, p_item_photo_path: hand, p_manual_reason: 'Documento conferido na portaria' });
    const kinds = await db.sql('select kind, count(*)::int n from package_attachments where package_id=$1 group by kind order by kind', [pkg.id]);
    assert.deepEqual(kinds, [{ kind: 'handover_photo', n: 1 }, { kind: 'label_photo', n: 8 }, { kind: 'signature', n: 1 }]);
  } finally { await db.raw.close(); }
});
