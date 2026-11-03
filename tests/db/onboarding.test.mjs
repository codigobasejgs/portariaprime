// Onboarding retomável do teste grátis — 20261103000400.
// Rascunho por conta, retomada da etapa, ativação idempotente (mesmo request_id), sem tenant
// duplicado, data do teste pelo servidor, limites do plano e isolamento entre contas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('onboarding: rascunho no servidor, retomada e ativação única', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const [a, b] = await Promise.all(['a@onb.invalid', 'b@onb.invalid'].map((e) => db.createUser(e)));
    const data = { name: 'Residencial Aurora', slug: 'aurora', document: '11444777000161', phone: '', timezone: 'America/Sao_Paulo', plan: 'prime', cycle: 'yearly', evil: 'x', password: 'nunca' };

    // Sem rascunho: estado vazio, prévia do fim do teste calculada no servidor.
    db.setNow('2026-01-31T12:00:00Z');
    const s0 = await db.rpc(a, 'onboarding_state', { p_timezone: 'America/Sao_Paulo' });
    assert.equal(s0.draft, null);
    assert.equal(new Date(s0.trial_end_preview).toISOString(), '2026-02-28T12:00:00.000Z', 'um mês de calendário (31/01 → 28/02)');

    // Salvar etapa 1 → 2 → 3; campos fora da lista (inclusive senha) são descartados.
    const sv1 = await db.rpc(a, 'onboarding_save', { p_step: 2, p_data: data });
    const sv2 = await db.rpc(a, 'onboarding_save', { p_step: 3, p_data: { ...data, cycle: 'quarterly' } });
    assert.equal(sv1.request_id, sv2.request_id, 'mesmo request_id entre etapas');
    const s1 = await db.rpc(a, 'onboarding_state', {});
    assert.equal(s1.draft.step, 3, 'F5/reabertura volta para a etapa salva');
    assert.equal(s1.draft.data.cycle, 'quarterly');
    assert.equal(s1.draft.data.evil, undefined);
    assert.equal(s1.draft.data.password, undefined, 'senha nunca é guardada');
    await assert.rejects(db.rpc(a, 'onboarding_save', { p_step: 9, p_data: data }), /inválidos/);
    await assert.rejects(db.rpc(null, 'onboarding_state', {}), /login|permission|denied/i);

    // Isolamento: B não vê o rascunho de A; tabela inacessível diretamente.
    assert.equal((await db.rpc(b, 'onboarding_state', {})).draft, null);
    await assert.rejects(db.as(b, 'select * from onboarding_drafts'), /permission denied/);

    // Slug: disponível antes, indisponível depois.
    assert.equal(await db.rpc(a, 'slug_available', { p_slug: 'aurora' }), true);
    assert.equal(await db.rpc(a, 'slug_available', { p_slug: 'A B' }), false);

    // Ativação: duas chamadas com o mesmo request_id (duplo clique / retry / refresh) = um condomínio.
    const args = { p_request_id: sv1.request_id, p_name: data.name, p_slug: data.slug, p_document: data.document, p_timezone: data.timezone, p_plan_code: 'prime', p_cycle: 'quarterly' };
    const [r1, r2] = [await db.rpc(a, 'provision_tenant', args), await db.rpc(a, 'provision_tenant', args)];
    assert.equal(r1.tenant_id, r2.tenant_id);
    assert.equal(r2.replayed, true);
    assert.equal((await db.sql("select count(*)::int n from tenants where slug = 'aurora'"))[0].n, 1);
    assert.equal((await db.sql('select count(*)::int n from subscriptions where tenant_id = $1', [r1.tenant_id]))[0].n, 1, 'um único período de teste');
    assert.equal(await db.rpc(a, 'slug_available', { p_slug: 'aurora' }), false);

    // Retomada após ativar: estado traz o condomínio (tela de sucesso), datas do servidor, plano escolhido.
    const s2 = await db.rpc(a, 'onboarding_state', {});
    assert.equal(s2.tenant.slug, 'aurora');
    assert.equal(s2.tenant.status, 'trialing');
    assert.equal(s2.tenant.cycle, 'quarterly');
    assert.equal(new Date(s2.tenant.trial_started_at).toISOString(), '2026-01-31T12:00:00.000Z');
    assert.equal(new Date(s2.tenant.trial_ends_at).toISOString(), '2026-02-28T12:00:00.000Z');
    await assert.rejects(db.rpc(a, 'onboarding_save', { p_step: 2, p_data: data }), /já foi ativado/);

    // Limites do plano escolhido aplicados ao condomínio.
    const [lim] = await db.sql("select e.max_units from plan_entitlements e join plans p on p.id = e.plan_id where p.code = 'prime'");
    const [cur] = await db.sql('select e.max_units from subscriptions s join plan_entitlements e on e.plan_id = s.plan_id where s.tenant_id = $1', [r1.tenant_id]);
    assert.equal(cur.max_units, lim.max_units);

    // B usando o request_id de A não assume o condomínio de A.
    await assert.rejects(db.rpc(b, 'provision_tenant', { ...args }), /permissão|Sem/i);
    // Mesmo documento por outra conta: segundo teste grátis negado, nada criado.
    await assert.rejects(db.rpc(b, 'provision_tenant', { ...args, p_request_id: crypto.randomUUID(), p_slug: 'aurora-2' }), /já utilizou o mês gratuito/);
    assert.equal((await db.sql("select count(*)::int n from tenants where slug = 'aurora-2'"))[0].n, 0);

    // "Cadastrar outro condomínio": reset gera novo request_id e não toca o condomínio existente.
    await db.rpc(a, 'onboarding_reset', {});
    const sv3 = await db.rpc(a, 'onboarding_save', { p_step: 2, p_data: { ...data, slug: 'aurora-norte' } });
    assert.notEqual(sv3.request_id, sv1.request_id);
    assert.equal((await db.sql("select count(*)::int n from tenants where slug = 'aurora'"))[0].n, 1);
  } finally { await db.raw.close(); }
});
