// Validação pública de comprovante: código opaco por comprovante novo, anon
// consulta, resposta mínima (sem dados pessoais) e uniforme para inválido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('verify_receipt: código opaco, resposta mínima e uniforme', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const uuid = () => crypto.randomUUID();
    const [admin, port] = await Promise.all(['sindico@ver.invalid', 'porteiro@ver.invalid'].map((e) => db.createUser(e)));
    const T = (await db.rpc(admin, 'provision_tenant', { p_request_id: uuid(), p_name: 'Residencial Verifica', p_slug: 'ver-cond', p_document: '11444777000161',
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    await db.sql("update tenant_branding set display_name='Residencial Exibição' where tenant_id=$1", [T]);
    const [{ id: unit }] = await db.as(admin, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [T]);
    const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: 'porteiro@ver.invalid', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
    await db.rpc(port, 'accept_invitation', { p_token: inv.token });

    const deliver = async (key) => {
      const pkg = await db.rpc(port, 'receive_package', { p_tenant: T, p_idempotency_key: key, p_unit: unit, p_tracking: null, p_carrier: 'Correios', p_courier: 'Entregador Teste', p_recipient: 'Fulano Sigiloso' });
      const sig = `${T}/packages/${pkg.id}/signature-sig${key.slice(-5)}.png`, hand = `${T}/packages/${pkg.id}/handover-han${key.slice(-5)}.jpg`;
      for (const p of [sig, hand]) await db.service("insert into storage.objects (bucket_id,name,owner) values ('tenant-private',$1,$2)", [p, port]);
      await db.rpc(port, 'deliver_package', { p_tenant: T, p_package: pkg.id, p_request: uuid(), p_qr: null, p_picked_up_by: 'Beltrano Retirante',
        p_recipient_kind: 'morador', p_signature_path: sig, p_item_photo_path: hand, p_manual_reason: 'Documento conferido na portaria' });
      return (await db.sql('select * from receipts where package_id=$1', [pkg.id]))[0];
    };
    const r1 = await deliver('ver-key-00001');
    const r2 = await deliver('ver-key-00002');
    assert.match(r1.verify_code, /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    assert.notEqual(r1.verify_code, r2.verify_code);
    assert.ok(!r1.verify_code.replace(/-/g, '').includes(r1.protocol.slice(-8)), 'não deriva do protocolo');

    // Anônimo valida; aceita minúsculas e sem hífens.
    const ok = await db.rpc(null, 'verify_receipt', { p_code: r1.verify_code.toLowerCase().replace(/-/g, ' ') });
    assert.deepEqual(Object.keys(ok).sort(), ['delivered_at', 'tenant_name', 'valid']);
    assert.equal(ok.valid, true);
    assert.equal(ok.tenant_name, 'Residencial Exibição');
    assert.equal(new Date(ok.delivered_at).getTime(), new Date(r1.snapshot.picked_up_at).getTime());
    const s = JSON.stringify(ok);
    for (const secret of ['Fulano', 'Beltrano', '101', 'signature', 'handover', r1.protocol, T, r1.package_id]) assert.ok(!s.includes(secret), secret);

    // Inválido: resposta idêntica para formato errado, código inexistente, protocolo e vazio.
    for (const bad of ['', null, 'xyz', '0000-0000-0000-0000-0000', r1.protocol, r1.verify_code + 'A', "' or 1=1 --", 'A'.repeat(5000)]) {
      assert.deepEqual(await db.rpc(null, 'verify_receipt', { p_code: bad }), { valid: false });
    }
    // Anônimo não lê a tabela nem o código diretamente.
    await assert.rejects(db.as(null, 'select verify_code from receipts'), /permission denied/);
    // Código é imutável (receipts só altera colunas do PDF).
    await assert.rejects(db.service("update receipts set verify_code='X' where id=$1", [r1.id]), /imutável/);
    // Worker recebe o código para imprimir no PDF.
    assert.equal((await db.service('select public.receipt_pdf_data($1) d', [r1.id]))[0].d.verify_code, r1.verify_code);
  } finally { await db.raw.close(); }
});
