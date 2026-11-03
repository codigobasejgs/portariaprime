// Auditoria de segurança das RPCs novas (0100 termo LGPD, 0200 dashboard, 0300 divulgação, 0400 onboarding).
// 1) Inventário: toda função nova em public é SECURITY DEFINER com search_path fixo, e nenhuma é executável por anon
//    (exceto privacy_term_current, pública por desenho: só o texto do termo vigente).
// 2) Matriz papel × função: visitante, morador, porteiro e síndico de OUTRO condomínio contra o condomínio A,
//    passando o tenant_id de A explicitamente (manipulação de tenant_id / IDOR) — tudo recusado.
// 3) Injeção: filtros e textos maliciosos não executam nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const NEW = ['privacy_terms_admin', 'privacy_term_save', 'privacy_term_publish', 'privacy_acknowledgements_list', 'privacy_term_current',
  'dashboard_executive', 'dashboard_unit_ranking', 'divulgacao_get', 'divulgacao_save', 'onboarding_state', 'onboarding_save', 'onboarding_reset', 'slug_available'];

test('RPCs novas: definer + search_path, sem anon, matriz de papéis e injeção', async () => {
  const db = await createDb();
  try {
    // 1) Inventário.
    const fns = await db.sql(`select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') cfg,
        has_function_privilege('anon', p.oid, 'execute') anon_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1)`, [NEW]);
    assert.equal(new Set(fns.map((f) => f.proname)).size, NEW.length, 'todas as RPCs novas existem');
    for (const f of fns) {
      assert.ok(f.prosecdef, `${f.proname}: security definer`);
      assert.match(f.cfg, /search_path=("")?$/, `${f.proname}: search_path fixo vazio`);
      assert.equal(f.anon_exec, f.proname === 'privacy_term_current', `${f.proname}: execução por anon`);
    }
    // Helpers internos (app.*) das migrations novas: ninguém de fora executa.
    const internal = await db.sql(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') auth_exec, has_function_privilege('anon', p.oid, 'execute') anon_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
       and p.proname in ('dash_packages', 'dash_check_period', 'divulgacao_valid', 'onboarding_tenant', 'privacy_term_default', 'privacy_term_guard', 'privacy_ack_guard')`);
    assert.equal(internal.length, 7);
    for (const f of internal) assert.ok(!f.auth_exec && !f.anon_exec, `app.${f.proname} fechado`);
    // No Supabase hospedado, tabelas novas em public herdam ALL (inclusive TRUNCATE, que o RLS não barra)
    // para anon/authenticated. O PGlite não tem esse padrão: reproduz e confirma que a 0500 limpa.
    await db.raw.exec('grant all on public.access_requests, public.privacy_terms, public.privacy_acknowledgements to anon, authenticated');
    await db.applyMigration('20261103000500_revoke_default_table_grants.sql');
    for (const t of ['access_requests', 'privacy_terms', 'privacy_acknowledgements']) {
      const [p] = await db.sql(`select has_table_privilege('anon', $1, 'select') a, has_table_privilege('authenticated', $1, 'truncate') tr,
        has_table_privilege('authenticated', $1, 'select') s`, [`public.${t}`]);
      assert.deepEqual([p.a, p.tr, p.s], [false, false, true], `${t}: padrão do Supabase revogado pela 0500`);
    }
    // Tabelas novas: nada de escrita direta por usuários.
    for (const t of ['privacy_terms', 'privacy_acknowledgements', 'portal_divulgacao', 'onboarding_drafts']) {
      const [p] = await db.sql(`select has_table_privilege('authenticated', $1, 'insert') i, has_table_privilege('authenticated', $1, 'update') u,
        has_table_privilege('authenticated', $1, 'delete') d, has_table_privilege('anon', $1, 'select') s`, [`public.${t}`]);
      assert.deepEqual([p.i, p.u, p.d, p.s], [false, false, false, false], `${t}: sem escrita direta e sem leitura anônima`);
    }

    // 2) Matriz de papéis contra o condomínio A.
    await db.sql('update plans set published = true');
    const mk = (e, name) => db.createUser(e, { name });
    const [admA, admB, port, mor, outsider] = await Promise.all([mk('a@sec.invalid', 'Síndica A'), mk('b@sec.invalid', 'Síndico B'),
      mk('p@sec.invalid', 'Porteiro A'), mk('m@sec.invalid', 'Moradora A'), mk('x@sec.invalid', 'Sem Vinculo')]);
    const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `C ${slug}`, p_slug: slug,
      p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
    const A = await prov(admA, 'sec-a', '11444777000161');
    await prov(admB, 'sec-b', '11222333000181');
    const [{ id: unit }] = await db.as(admA, "insert into units(tenant_id,block,label) values($1,'A','101') returning id", [A]);
    for (const [uid, email, role, u] of [[port, 'p@sec.invalid', 'porteiro', null], [mor, 'm@sec.invalid', 'morador', unit]]) {
      const inv = await db.rpc(admA, 'create_invitation', { p_tenant: A, p_email: email, p_role: role, p_unit: u, p_permissions: '{}' });
      await db.rpc(uid, 'accept_invitation', { p_token: inv.token });
    }
    const today = '2026-11-03';
    const draft = await db.rpc(admA, 'privacy_term_save', { p_tenant: A, p_id: null, p_version: '1.0', p_title: 'Termo', p_content: 'x'.repeat(60), p_note: null });
    const calls = {
      privacy_terms_admin: { p_tenant: A },
      privacy_term_save: { p_tenant: A, p_id: null, p_version: '9.9', p_title: 'Invasão', p_content: 'y'.repeat(60), p_note: null },
      privacy_term_publish: { p_tenant: A, p_id: draft.id },
      privacy_acknowledgements_list: { p_tenant: A, p_limit: 10, p_offset: 0 },
      dashboard_executive: { p_tenant: A, p_from: today, p_to: today, p_filters: {} },
      dashboard_unit_ranking: { p_tenant: A, p_from: today, p_to: today, p_filters: {}, p_limit: 10, p_offset: 0 },
      divulgacao_get: { p_tenant: A },
      divulgacao_save: { p_tenant: A, p_model: 'cartaz', p_texts: { title: 'Invasão' } },
    };
    const who = { visitante: null, sem_vinculo: outsider, morador: mor, porteiro: port, sindico_de_B: admB };
    const leaks = [];
    for (const [fn, args] of Object.entries(calls)) {
      for (const [role, uid] of Object.entries(who)) {
        const ok = await db.rpc(uid, fn, args).then(() => true, () => false);
        if (ok) leaks.push(`${role} → ${fn}`);
      }
    }
    assert.deepEqual(leaks, [], `acessos indevidos: ${leaks.join('; ')}`);
    // Nada foi gravado pelas tentativas.
    assert.equal((await db.sql("select count(*)::int n from privacy_terms where tenant_id = $1 and version = '9.9'", [A]))[0].n, 0);
    assert.equal((await db.sql('select status from privacy_terms where id = $1', [draft.id]))[0].status, 'draft', 'ninguém publicou');
    assert.equal((await db.sql('select count(*)::int n from portal_divulgacao where tenant_id = $1', [A]))[0].n, 0);
    // O próprio síndico de A acessa.
    assert.ok(await db.rpc(admA, 'dashboard_executive', calls.dashboard_executive));
    assert.ok(await db.rpc(admA, 'divulgacao_get', calls.divulgacao_get));

    // Onboarding: rascunho é por usuário (auth.uid()), sem parâmetro de tenant — não há como apontar para o de outro.
    await db.rpc(admB, 'onboarding_save', { p_step: 2, p_data: { name: 'Do B' } });
    assert.equal((await db.rpc(admA, 'onboarding_state', {})).draft, null, 'A não vê o rascunho de B');

    // 3) Injeção.
    for (const evil of ["'; drop table packages; --", 'PENDENTES\') or 1=1 --', '{"$ne":null}']) {
      await assert.rejects(db.rpc(admA, 'dashboard_executive', { p_tenant: A, p_from: today, p_to: today, p_filters: { status: evil } }), /inválido/);
      await assert.rejects(db.rpc(admA, 'dashboard_executive', { p_tenant: A, p_from: today, p_to: today, p_filters: { unit: evil } }), /inválido/);
    }
    // Bloco com texto arbitrário é só comparação (parâmetro), nunca SQL.
    const d = await db.rpc(admA, 'dashboard_executive', { p_tenant: A, p_from: today, p_to: today, p_filters: { block: "A' or '1'='1" } });
    assert.equal(d.received.value, 0);
    assert.equal((await db.sql('select count(*)::int n from packages'))[0].n >= 0, true, 'tabela intacta');
    await assert.rejects(db.rpc(admA, 'slug_available', { p_slug: "x'; drop table tenants; --" }).then((r) => { if (r !== false) throw new Error('aceitou'); throw new Error('ok'); }), /ok/);
    assert.ok((await db.sql('select count(*)::int n from tenants'))[0].n >= 2, 'tenants intacta');
    await assert.rejects(db.rpc(admA, 'onboarding_save', { p_step: 1, p_data: { name: '<img src=x onerror=alert(1)>' } }).then(async () => {
      const s = await db.rpc(admA, 'onboarding_state', {});
      // Texto é guardado como dado (React escapa ao exibir); o que importa é não executar nada no banco.
      if (s.draft.data.name !== '<img src=x onerror=alert(1)>') throw new Error('alterado');
      throw new Error('guardado como texto');
    }), /guardado como texto/);
  } finally { await db.raw.close(); }
});
