// Teste ponta a ponta contra um projeto Supabase REAL (Auth + PostgREST + RLS + Storage).
// Usa a chave pública como usuário comum; service role só para criar/limpar usuários sintéticos.
// Cria dois condomínios de teste; preserva fixtures para diagnóstico na stack local.
// NÃO roda contra projetos hospedados: exige PP_E2E_ALLOW=1 e URL Supabase de loopback.
//
// PP_E2E_ALLOW=1 SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node --test tests/e2e/supabase-real.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (process.env.PP_E2E_ALLOW !== '1' || !url || !anon || !secret) {
  test('e2e real ignorado (defina PP_E2E_ALLOW=1 e as chaves)', { skip: true }, () => {});
} else {
  assertLocalSupabase(url);
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const svc = createClient(url, secret, opts);
  const run = `e2e${Date.now().toString(36)}`;
  const users = {};
  const created = [];
  const tenants = {};
  const doc = (n) => String(10_000_000_000_000 + Number(BigInt(Date.now()) % 9_000_000_000_000n) + n).slice(0, 14);

  async function makeUser(key) {
    const email = `${run}-${key}@e2e.portariaprime.invalid`;
    const password = `S${crypto.randomUUID()}!`;
    const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `E2E ${key}` } });
    if (error) throw error;
    created.push(data.user.id);
    const client = createClient(url, anon, opts);
    const { error: e2 } = await client.auth.signInWithPassword({ email, password });
    if (e2) throw e2;
    users[key] = { id: data.user.id, email, client };
    return users[key];
  }
  const rpc = async (key, fn, args) => {
    const { data, error } = await users[key].client.rpc(fn, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  };

  before(async () => {
    const { count } = await svc.from('tenants').select('id', { count: 'exact', head: true }).not('slug', 'like', 'e2e%');
    assert.equal(count, 0, 'Banco contém condomínios reais: e2e destrutivo-por-limpeza recusado.');
    // Planos precisam estar publicados para o teste; restaura o estado ao final.
    const { data: plans } = await svc.from('plans').select('code, published');
    before.publishedBefore = plans;
    await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
    for (const k of ['adminA', 'adminB', 'porteiroA', 'moradorA', 'moradorA2', 'moradorA3', 'moradorB', 'intruso']) await makeUser(k);
    for (const [key, admin, n] of [['A', 'adminA', 1], ['B', 'adminB', 2]]) {
      const r = await rpc(admin, 'provision_tenant', {
        p_request_id: crypto.randomUUID(), p_name: `E2E ${key}`, p_slug: `${run}-${key.toLowerCase()}`, p_document: doc(n),
        p_timezone: 'America/Sao_Paulo', p_plan_code: 'profissional', p_cycle: 'monthly', p_contact_phone: null,
      });
      tenants[key] = r.tenant_id;
    }
  });

  after(async () => {
    // Preserva fixtures na stack isolada para diagnóstico. Nada apaga auditoria,
    // desliga FKs ou remove metadados do Storage diretamente.
    console.log(`Fixtures locais preservadas: ${run}; usuários sintéticos: ${created.length}.`);
    for (const p of before.publishedBefore || []) await svc.from('plans').update({ published: p.published }).eq('code', p.code);
  });

  test('trial real de 1 mês criado no servidor, sem cobrança antecipada', async () => {
    const ov = await rpc('adminA', 'subscription_overview', { p_tenant: tenants.A });
    assert.equal(ov.status, 'trialing');
    assert.equal(ov.commercial_state, 'full');
    const days = (new Date(ov.trial_ends_at) - new Date(ov.trial_started_at)) / 86400000;
    assert.ok(days >= 28 && days <= 31, `teste de ${days} dias`);
    await assert.rejects(rpc('adminA', 'prepare_checkout', { p_tenant: tenants.A }), /mês grátis/);
  });

  let unitA, unitB, pkg;
  test('mesmo bloco/unidade nos dois condomínios; A não vê nem grava em B', async () => {
    ({ data: { id: unitA } } = await users.adminA.client.from('units').insert({ tenant_id: tenants.A, block: 'A', label: '101' }).select('id').single());
    ({ data: { id: unitB } } = await users.adminB.client.from('units').insert({ tenant_id: tenants.B, block: 'A', label: '101' }).select('id').single());
    assert.ok(unitA && unitB);
    const { data: seen } = await users.adminA.client.from('units').select('id');
    assert.ok(seen.every((u) => u.id !== unitB));
    const { error } = await users.adminA.client.from('units').insert({ tenant_id: tenants.B, label: 'X' });
    assert.ok(error, 'insert em B deveria falhar');
    const { data: upd } = await users.adminA.client.from('units').update({ label: 'hack' }).eq('id', unitB).select('id');
    assert.equal(upd.length, 0);
    const { data: real } = await svc.from('units').select('label').eq('id', unitB).single();
    assert.equal(real.label, '101');
  });

  test('convites: porteiro e morador entram; intruso e endereço não dão acesso', async () => {
    const p = await rpc('adminA', 'create_invitation', { p_tenant: tenants.A, p_email: users.porteiroA.email, p_role: 'porteiro', p_unit: null, p_permissions: [] });
    await rpc('porteiroA', 'accept_invitation', { p_token: p.token });
    const m = await rpc('adminA', 'create_invitation', { p_tenant: tenants.A, p_email: users.moradorA.email, p_role: 'morador', p_unit: unitA, p_permissions: [] });
    await assert.rejects(rpc('intruso', 'accept_invitation', { p_token: m.token }), /outro e-mail/);
    await rpc('moradorA', 'accept_invitation', { p_token: m.token });
    await assert.rejects(rpc('moradorA', 'accept_invitation', { p_token: m.token }), /já foi utilizado/);
    for (const k of ['moradorA2', 'moradorA3']) {
      const inv = await rpc('adminA', 'create_invitation', { p_tenant: tenants.A, p_email: users[k].email, p_role: 'morador', p_unit: unitA, p_permissions: [] });
      await rpc(k, 'accept_invitation', { p_token: inv.token });
    }
    const mb = await rpc('adminB', 'create_invitation', { p_tenant: tenants.B, p_email: users.moradorB.email, p_role: 'morador', p_unit: unitB, p_permissions: [] });
    await rpc('moradorB', 'accept_invitation', { p_token: mb.token });
    const { error } = await users.intruso.client.from('unit_memberships').insert({ tenant_id: tenants.A, unit_id: unitA, user_id: users.intruso.id });
    assert.ok(error, 'intruso não pode se vincular a unidade sabendo o endereço');
  });

  test('recebimento, foto no bucket privado, QR, retirada com assinatura e comprovante', async () => {
    pkg = await rpc('porteiroA', 'receive_package', {
      p_tenant: tenants.A, p_idempotency_key: `${run}-k1`, p_unit: unitA, p_tracking: `${run}BR1`, p_carrier: 'Correios', p_courier: 'Entregador Teste',
      p_recipient: 'Destinatário E2E', p_notes: null, p_concierge: null, p_storage_location: null,
    });
    const again = await rpc('porteiroA', 'receive_package', {
      p_tenant: tenants.A, p_idempotency_key: `${run}-k1`, p_unit: unitA, p_tracking: `${run}BR1`, p_carrier: 'Correios', p_courier: 'Entregador Teste',
      p_recipient: null, p_notes: null, p_concierge: null, p_storage_location: null,
    });
    assert.equal(again.id, pkg.id, 'retry não duplica');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const photo = `${tenants.A}/packages/${pkg.id}/label_photo-${run}abcd.png`;
    const up = await users.porteiroA.client.storage.from('tenant-private').upload(photo, png, { contentType: 'image/png' });
    assert.ifError(up.error);
    await rpc('porteiroA', 'attach_package_file', { p_tenant: tenants.A, p_package: pkg.id, p_kind: 'label_photo', p_path: photo });
    const cross = await users.adminB.client.storage.from('tenant-private').createSignedUrl(photo, 60);
    assert.ok(cross.error || !cross.data, 'admin de B não assina URL de A');
    const { data: notif } = await users.moradorA.client.from('notifications').select('id').eq('tenant_id', tenants.A);
    assert.ok(notif.length >= 1, 'morador recebeu aviso interno');
    const { data: leak } = await users.moradorB.client.from('packages').select('id').eq('tenant_id', tenants.A);
    assert.equal(leak.length, 0);

    const { token } = await rpc('moradorA', 'issue_pickup_token', { p_tenant: tenants.A, p_package: pkg.id });
    await assert.rejects(rpc('adminB', 'lookup_pickup_token', { p_tenant: tenants.B, p_qr: token }), /não reconhecido/);
    // Consulta não consome: duas leituras seguidas.
    await rpc('porteiroA', 'lookup_pickup_token', { p_tenant: tenants.A, p_qr: token });
    await rpc('porteiroA', 'lookup_pickup_token', { p_tenant: tenants.A, p_qr: token });
    // Cada operador envia as próprias provas (owner do objeto = quem confirma).
    const proofs = async (key) => {
      const sig = `${tenants.A}/packages/${pkg.id}/signature-${key}${run}.png`;
      const photo = `${tenants.A}/packages/${pkg.id}/handover-${key}${run}.png`;
      for (const path of [sig, photo]) assert.ifError((await users[key].client.storage.from('tenant-private').upload(path, png, { contentType: 'image/png' })).error);
      return { p_signature_path: sig, p_item_photo_path: photo };
    };
    const base = { p_tenant: tenants.A, p_package: pkg.id, p_qr: token, p_picked_up_by: 'Retirante E2E', p_recipient_kind: 'morador', p_manual_reason: null };
    const pa = await proofs('porteiroA');
    const pb = await proofs('adminA');
    // Foto do item é obrigatória e prova de outro operador não vale.
    await assert.rejects(rpc('porteiroA', 'deliver_package', { ...base, p_request: crypto.randomUUID(), ...pa, p_item_photo_path: null }), /Foto do item/);
    await assert.rejects(rpc('porteiroA', 'deliver_package', { ...base, p_request: crypto.randomUUID(), ...pb }), /Assinatura não recebida/);
    // Cliente não alcança a baixa direta sem provas.
    assert.ok((await users.porteiroA.client.rpc('confirm_pickup', { p_tenant: tenants.A, p_package: pkg.id, p_method: 'qr', p_qr: token, p_picked_up_by: 'x', p_signature_path: pa.p_signature_path, p_handover_path: null, p_manual_reason: null })).error);
    const reqA = crypto.randomUUID();
    const [r1, r2] = await Promise.allSettled([
      rpc('porteiroA', 'deliver_package', { ...base, p_request: reqA, ...pa }),
      rpc('adminA', 'deliver_package', { ...base, p_request: crypto.randomUUID(), ...pb }),
    ]);
    assert.equal([r1, r2].filter((r) => r.status === 'fulfilled').length, 1, 'exatamente uma retirada vence (conexões distintas)');
    const { data: receipt } = await users.moradorA.client.from('receipts').select('protocol, snapshot').eq('package_id', pkg.id).single();
    assert.match(receipt.protocol, /^PP-/);
    assert.equal(receipt.snapshot.picked_up_by, 'Retirante E2E');
    if (r1.status === 'fulfilled') {
      const again = await rpc('porteiroA', 'deliver_package', { ...base, p_request: reqA, ...pa });
      assert.equal(again.protocol, receipt.protocol, 'retry devolve o mesmo protocolo');
    }
    // Os três moradores da unidade veem comprovante e aviso; o de outro condomínio não.
    for (const k of ['moradorA', 'moradorA2', 'moradorA3']) {
      const { data: rc } = await users[k].client.from('receipts').select('protocol').eq('package_id', pkg.id);
      assert.equal(rc.length, 1, `${k} vê o comprovante`);
      const { data: nt } = await users[k].client.from('notifications').select('kind').eq('package_id', pkg.id);
      assert.deepEqual(nt.map((n) => n.kind).sort(), ['package_picked_up', 'package_received'], `${k} avisado`);
      const { data: img } = await users[k].client.storage.from('tenant-private').createSignedUrl(receipt.snapshot.handover_path, 60);
      assert.ok(img?.signedUrl, `${k} abre a foto do item`);
    }
    const { data: none } = await users.moradorB.client.from('receipts').select('id').eq('package_id', pkg.id);
    assert.equal(none.length, 0);
    const { data: jobs } = await svc.from('notification_jobs').select('channel, recipient').eq('ref_id', pkg.id).eq('event', 'package_picked_up');
    assert.equal(jobs.filter((j) => j.channel === 'push').length, 3);
    assert.equal(jobs.filter((j) => j.channel === 'email').length, 3);
  });

  test('revogação vale imediatamente com JWT ainda válido', async () => {
    const { data: m } = await svc.from('tenant_memberships').select('id').eq('tenant_id', tenants.A).eq('user_id', users.porteiroA.id).single();
    await rpc('adminA', 'set_membership_status', { p_membership: m.id, p_status: 'revoked' });
    const { data } = await users.porteiroA.client.from('packages').select('id').eq('tenant_id', tenants.A);
    assert.equal(data.length, 0);
    await assert.rejects(rpc('porteiroA', 'receive_package', {
      p_tenant: tenants.A, p_idempotency_key: `${run}-k2`, p_unit: unitA, p_tracking: null, p_carrier: 'Outra', p_courier: 'Entregador Teste',
      p_recipient: null, p_notes: null, p_concierge: null, p_storage_location: null,
    }), /Sem permissão/);
  });

  test('anônimo e cliente comum não alcançam funções de serviço nem cobrança', async () => {
    const anonClient = createClient(url, anon, opts);
    assert.ok((await anonClient.from('packages').select('id')).error);
    assert.ok((await users.adminA.client.rpc('apply_verified_payment', { p_order_nsu: 'x', p_transaction_nsu: 'x', p_slug: 'x', p_amount: 1, p_paid_amount: 1, p_installments: 1, p_capture_method: 'pix', p_receipt_url: null })).error);
    assert.ok((await users.adminA.client.rpc('claim_checkout_link', { p_order: crypto.randomUUID(), p_attempt: crypto.randomUUID() })).error);
    const { data: subs } = await users.adminA.client.from('subscriptions').update({ status: 'active' }).eq('tenant_id', tenants.A).select('id');
    assert.equal((subs || []).length, 0, 'gestor não altera assinatura direto');
  });
}
