// Comprovante PDF: layout por condomínio com permissão, snapshot imutável,
// canais retidos até o PDF, worker idempotente, acesso histórico por vínculo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('layout, snapshot, retenção dos canais, conclusão única e acesso', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const uuid = () => crypto.randomUUID();
    const [adminA, adminB, port, mor, novo] = await Promise.all(['sindicoa@pdf.invalid', 'sindicob@pdf.invalid', 'porteiro@pdf.invalid', 'morador@pdf.invalid', 'novo@pdf.invalid'].map((e) => db.createUser(e)));
    const prov = async (u, slug, doc) => (await db.rpc(u, 'provision_tenant', { p_request_id: uuid(), p_name: slug, p_slug: slug, p_document: doc,
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const A = await prov(adminA, 'pdf-a', '11444777000161');
    const B = await prov(adminB, 'pdf-b', '11222333000181');
    const [{ id: unit }] = await db.as(adminA, "insert into units(tenant_id,block,label) values($1,'A','12B') returning id", [A]);
    for (const [u, email, role, un] of [[port, 'porteiro@pdf.invalid', 'porteiro', null], [mor, 'morador@pdf.invalid', 'morador', unit]]) {
      const inv = await db.rpc(adminA, 'create_invitation', { p_tenant: A, p_email: email, p_role: role, p_unit: un, p_permissions: '{}' });
      await db.rpc(u, 'accept_invitation', { p_token: inv.token });
    }
    await db.sql("update resident_contacts set phone='+5511999990000' where tenant_id=$1", [A]);

    // Layout: só administrador com "settings" do próprio condomínio.
    await db.rpc(adminA, 'save_receipt_layout', { p_tenant: A, p: { template: 'moderno', color_primary: '#126B61', footer: 'Rodapé A' } });
    await db.rpc(adminB, 'save_receipt_layout', { p_tenant: B, p: { template: 'compacto', footer: 'Rodapé B' } });
    await assert.rejects(db.rpc(port, 'save_receipt_layout', { p_tenant: A, p: { template: 'compacto' } }), /administrador/);
    await assert.rejects(db.rpc(mor, 'save_receipt_layout', { p_tenant: A, p: { template: 'compacto' } }), /administrador/);
    await assert.rejects(db.rpc(adminB, 'save_receipt_layout', { p_tenant: A, p: { template: 'compacto' } }), /administrador/);
    await assert.rejects(db.rpc(adminA, 'save_receipt_layout', { p_tenant: A, p: { template: 'html-livre' } }), /check/);
    await assert.rejects(db.as(adminA, 'select * from receipt_layouts'), /permission denied/);
    assert.equal((await db.rpc(mor, 'receipt_layout', { p_tenant: A })), null);
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action='receipt_layout.saved' and tenant_id=$1", [A]))[0].n, 1);

    // Retirada → comprovante com snapshot do layout de A.
    const pkg = await db.rpc(port, 'receive_package', { p_tenant: A, p_idempotency_key: 'pdf-key-001', p_unit: unit, p_tracking: 'BR1', p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    const sig = `${A}/packages/${pkg.id}/signature-sig00001.png`, photo = `${A}/packages/${pkg.id}/handover-pho00001.jpg`;
    for (const p of [sig, photo]) await db.service("insert into storage.objects (bucket_id,name,owner) values ('tenant-private',$1,$2)", [p, port]);
    const req = uuid();
    const args = { p_tenant: A, p_package: pkg.id, p_request: req, p_qr: null, p_picked_up_by: 'Pessoa', p_recipient_kind: 'morador',
      p_signature_path: sig, p_item_photo_path: photo, p_manual_reason: 'Documento conferido na portaria' };
    await db.rpc(port, 'deliver_package', args);
    await db.rpc(port, 'deliver_package', args); // retry: mesmo evento
    const receipts = await db.sql('select * from receipts where package_id=$1', [pkg.id]);
    assert.equal(receipts.length, 1);
    const r = receipts[0];
    assert.equal(r.pdf_status, 'pending');
    assert.equal(r.layout.template, 'moderno');
    assert.equal(r.layout.footer, 'Rodapé A');

    // Canais com anexo retidos; push sai na hora.
    const jobs = await db.sql("select channel, status from notification_jobs where ref_id=$1 and event='package_picked_up'", [pkg.id]);
    assert.ok(jobs.filter((j) => j.channel !== 'push').every((j) => j.status === 'hold'));
    assert.ok(jobs.some((j) => j.channel === 'whatsapp') && jobs.some((j) => j.channel === 'email'));
    // Worker de avisos não pega os retidos.
    const held = (await db.sql("select id from notification_jobs where ref_id=$1 and status='hold'", [pkg.id])).map((j) => j.id);
    const claimed = (await db.service('select id from claim_notification_jobs(50)')).map((j) => j.id);
    assert.ok(held.length > 0 && held.every((id) => !claimed.includes(id)));

    // Layout alterado depois não muda o comprovante já emitido.
    await db.rpc(adminA, 'save_receipt_layout', { p_tenant: A, p: { template: 'classico', footer: 'Novo' } });
    assert.equal((await db.sql('select layout from receipts where id=$1', [r.id]))[0].layout.footer, 'Rodapé A');

    // Worker: dois workers não pegam o mesmo; conclusão única libera os canais.
    const c1 = await db.service('select id from claim_receipt_pdfs(5)');
    const c2 = await db.service('select id from claim_receipt_pdfs(5)');
    assert.equal(c1.length, 1); assert.equal(c2.length, 0);
    await assert.rejects(db.as(port, 'select claim_receipt_pdfs(5)'), /permission denied/);
    await assert.rejects(db.service("select complete_receipt_pdf($1,$2,$3,1000,'pdf-1',null)", [r.id, `${B}/receipts/${pkg.id}/x-12345678.pdf`, 'a'.repeat(64)]), /inválido/);
    const path = `${A}/receipts/${pkg.id}/comprovante-${r.protocol}.pdf`;
    await db.service("select complete_receipt_pdf($1,$2,$3,1000,'pdf-1',null)", [r.id, path, 'a'.repeat(64)]);
    await db.service("select complete_receipt_pdf($1,$2,$3,1000,'pdf-1',null)", [r.id, path.replace('.pdf', '-2.pdf'), 'b'.repeat(64)]);
    const done = (await db.sql('select pdf_status, pdf_path, pdf_sha256 from receipts where id=$1', [r.id]))[0];
    assert.deepEqual([done.pdf_status, done.pdf_path, done.pdf_sha256], ['ready', path, 'a'.repeat(64)]);
    assert.ok((await db.sql("select status from notification_jobs where ref_id=$1 and channel<>'push' and event='package_picked_up'", [pkg.id])).every((j) => j.status === 'queued'));
    await assert.rejects(db.service("update receipts set pdf_path='outro' where id=$1", [r.id]), /imutável/);
    await assert.rejects(db.service("update receipts set protocol='X' where id=$1", [r.id]), /imutável/);

    // Acesso: morador da unidade (vinculado antes da entrega) e equipe; outro tenant e ocupante novo não.
    assert.equal((await db.rpc(mor, 'receipt_pdf_access', { p_tenant: A, p_package: pkg.id })).path, path);
    assert.equal((await db.rpc(port, 'receipt_pdf_access', { p_tenant: A, p_package: pkg.id })).status, 'ready');
    await assert.rejects(db.rpc(adminB, 'receipt_pdf_access', { p_tenant: A, p_package: pkg.id }), /sem permissão/);
    await assert.rejects(db.rpc(adminB, 'receipt_pdf_access', { p_tenant: B, p_package: pkg.id }), /sem permissão/);
    // Falha de PDF: retirada continua válida; após 5 falhas o síndico é alertado e pode reprocessar.
    const pkg2 = await db.rpc(port, 'receive_package', { p_tenant: A, p_idempotency_key: 'pdf-key-002', p_unit: unit, p_tracking: 'BR2', p_carrier: 'Correios', p_courier: 'Entregador Teste' });
    const s2 = `${A}/packages/${pkg2.id}/signature-sig00002.png`, f2 = `${A}/packages/${pkg2.id}/handover-pho00002.jpg`;
    for (const p of [s2, f2]) await db.service("insert into storage.objects (bucket_id,name,owner) values ('tenant-private',$1,$2)", [p, port]);
    await db.rpc(port, 'deliver_package', { ...args, p_package: pkg2.id, p_request: uuid(), p_signature_path: s2, p_item_photo_path: f2 });
    const [r2] = await db.sql('select id from receipts where package_id=$1', [pkg2.id]);
    for (let i = 0; i < 5; i++) {
      await db.service('select claim_receipt_pdfs(5)');
      await db.service("select complete_receipt_pdf($1,null,null,null,null,'falha de teste')", [r2.id]);
    }
    assert.equal((await db.sql('select status from packages where id=$1', [pkg2.id]))[0].status, 'RETIRADA');
    assert.equal((await db.service('select id from claim_receipt_pdfs(5)')).length, 0);
    assert.equal((await db.rpc(adminA, 'receipt_pdf_health', { p_tenant: A })).failed.length, 1);
    await assert.rejects(db.rpc(port, 'retry_receipt_pdf', { p_tenant: A, p_receipt: r2.id }), /permissão/i);
    await db.rpc(adminA, 'retry_receipt_pdf', { p_tenant: A, p_receipt: r2.id });
    assert.equal((await db.service('select id from claim_receipt_pdfs(5)')).length, 1);
    // Ocupante que entra depois da entrega não vê comprovantes antigos.
    await db.sql("update unit_memberships set created_at = now() + interval '1 day' where tenant_id=$1", [A]);
    const inv = await db.rpc(adminA, 'create_invitation', { p_tenant: A, p_email: 'novo@pdf.invalid', p_role: 'morador', p_unit: unit, p_permissions: '{}' });
    await db.rpc(novo, 'accept_invitation', { p_token: inv.token });
    await assert.rejects(db.rpc(novo, 'receipt_pdf_access', { p_tenant: A, p_package: pkg.id }), /sem permissão/);

  } finally { await db.raw.close(); }
});
