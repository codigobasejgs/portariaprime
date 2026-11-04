// Acessos da equipe com e-mail e senha criados pelo síndico (migration 20261104000100).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('acesso com senha: só quem gerencia equipe, sem escalar, uso único, isolado por condomínio', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    // Login recente (exigido): claims com amr como o PostgREST.
    const fresh = async (uid, fn, args) => {
      const keys = Object.keys(args);
      await db.raw.exec('begin');
      try {
        await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
          [uid, JSON.stringify({ sub: uid, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
        await db.raw.exec('set local role authenticated');
        const r = await db.raw.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
        await db.raw.exec('commit');
        return r.rows[0].r;
      } catch (e) { await db.raw.exec('rollback'); throw e; }
    };
    const sind = await db.createUser('sind@a.invalid', { name: 'Síndica A' });
    const sindB = await db.createUser('sind@b.invalid', { name: 'Síndico B' });
    const { tenant_id: A } = await db.rpc(sind, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond A', p_slug: 'cond-a', p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
    const { tenant_id: B } = await db.rpc(sindB, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond B', p_slug: 'cond-b', p_document: '04252011000110', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
    const check = (uid, over = {}) => fresh(uid, 'app_staff_account_check', { p_tenant: A, p_email: 'Portaria.Noite@cond-a.invalid', p_full_name: 'Portaria Noite', p_role: 'porteiro', p_permissions: [], ...over });

    // Sem login recente: pede senha de novo.
    await assert.rejects(db.rpc(sind, 'app_staff_account_check', { p_tenant: A, p_email: 'x@a.invalid', p_full_name: 'Xx', p_role: 'porteiro', p_permissions: [] }), /Confirme sua senha/);
    // Síndico de B não cria acesso em A (IDOR por tenant_id).
    await assert.rejects(check(sindB), /Sem permissão/);
    // Validações.
    await assert.rejects(check(sind, { p_role: 'morador' }), /Papel inválido/);
    await assert.rejects(check(sind, { p_permissions: ['approve'] }), /só se aplicam a administradores/);
    await assert.rejects(check(sind, { p_role: 'admin', p_permissions: ['root'] }), /desconhecida/);
    await assert.rejects(check(sind, { p_email: 'sem-arroba' }), /E-mail inválido/);
    await assert.rejects(check(sind, { p_email: 'sind@b.invalid' }), /Já existe uma conta/, 'conta existente: só por convite (dono do e-mail)');

    // Fluxo feliz: intenção → usuário (como o Auth Admin faria) → vínculo.
    const chk = await check(sind);
    assert.equal(chk.email, 'portaria.noite@cond-a.invalid', 'e-mail normalizado');
    const porteiro = await db.createUser(chk.email, { name: 'Portaria Noite' });
    await assert.rejects(db.rpc(sind, 'app_staff_account_link', { p_request: chk.request_id, p_user: porteiro }), /permission denied/, 'vínculo só pelo backend');
    const link = await db.service('select public.app_staff_account_link($1, $2) r', [chk.request_id, porteiro]).then((r) => r[0].r);
    assert.equal(link.role, 'porteiro');
    const [mem] = await db.sql("select role, status, permissions from tenant_memberships where tenant_id=$1 and user_id=$2", [A, porteiro]);
    assert.deepEqual([mem.role, mem.status, mem.permissions], ['porteiro', 'active', []]);
    assert.equal((await db.sql('select full_name from profiles where id=$1', [porteiro]))[0].full_name, 'Portaria Noite');
    // Uso único; e não vincula conta de outro e-mail.
    await assert.rejects(db.service('select public.app_staff_account_link($1, $2)', [chk.request_id, porteiro]), /já utilizada/);
    const chk2 = await check(sind, { p_email: 'porteiro2@cond-a.invalid', p_full_name: 'Porteiro Dois' });
    await assert.rejects(db.service('select public.app_staff_account_link($1, $2)', [chk2.request_id, sindB]), /não corresponde/);
    assert.equal((await db.sql('select count(*)::int n from tenant_memberships where tenant_id=$1 and user_id=$2', [A, sindB]))[0].n, 0);

    // Admin delegado sem 'billing' não cria admin com 'billing' (não escala).
    const chkAdm = await check(sind, { p_email: 'gestor@cond-a.invalid', p_full_name: 'Gestor', p_role: 'admin', p_permissions: ['team', 'approve'] });
    const gestor = await db.createUser(chkAdm.email, { name: 'Gestor' });
    await db.service('select public.app_staff_account_link($1, $2)', [chkAdm.request_id, gestor]);
    await assert.rejects(check(gestor, { p_email: 'novo@cond-a.invalid', p_role: 'admin', p_permissions: ['billing'] }), /Sem permissão/);
    assert.ok(await check(gestor, { p_email: 'porteiro3@cond-a.invalid', p_full_name: 'Porteiro Tres' }), 'pode criar porteiro');
    // Quem perdeu 'team' entre a intenção e o vínculo: vínculo recusado.
    const chkLate = await check(gestor, { p_email: 'tarde@cond-a.invalid', p_full_name: 'Tarde Demais' });
    await db.sql("update tenant_memberships set permissions = '{approve}' where tenant_id=$1 and user_id=$2", [A, gestor]);
    const tarde = await db.createUser(chkLate.email, { name: 'Tarde' });
    await assert.rejects(db.service('select public.app_staff_account_link($1, $2)', [chkLate.request_id, tarde]), /não tem mais permissão/);
    // Intenção expirada.
    const chkOld = await check(sind, { p_email: 'velho@cond-a.invalid', p_full_name: 'Velho' });
    await db.sql("update staff_account_requests set expires_at = now() - interval '1 minute' where id=$1", [chkOld.request_id]);
    const velho = await db.createUser(chkOld.email, { name: 'Velho' });
    await assert.rejects(db.service('select public.app_staff_account_link($1, $2)', [chkOld.request_id, velho]), /expirada/);

    // Troca de senha: só contas criadas pelo condomínio, deste condomínio, por quem pode conceder o papel.
    assert.deepEqual(await fresh(sind, 'app_staff_password_check', { p_tenant: A, p_user: porteiro }), { user_id: porteiro });
    await assert.rejects(fresh(sindB, 'app_staff_password_check', { p_tenant: A, p_user: porteiro }), /Sem permissão|Só é possível/);
    await assert.rejects(fresh(sindB, 'app_staff_password_check', { p_tenant: B, p_user: porteiro }), /Só é possível/);
    await assert.rejects(fresh(sind, 'app_staff_password_check', { p_tenant: A, p_user: sind }), /própria senha/);
    await assert.rejects(fresh(sind, 'app_staff_password_check', { p_tenant: A, p_user: sindB }), /Só é possível/, 'conta que não foi criada aqui');
    // Conta usada também em outro condomínio: não troca por aqui.
    await db.sql("insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'porteiro', '{}', 'active')", [B, porteiro]);
    await assert.rejects(fresh(sind, 'app_staff_password_check', { p_tenant: A, p_user: porteiro }), /outro condomínio/);
    await db.sql('delete from tenant_memberships where tenant_id=$1 and user_id=$2', [B, porteiro]);
    await db.service('select public.app_staff_password_changed($1, $2, $3)', [A, porteiro, sind]);
    assert.ok((await db.sql('select password_changed_at from staff_login_accounts where user_id=$1', [porteiro]))[0].password_changed_at);

    // Lista para a tela e auditoria.
    assert.equal((await db.rpc(sind, 'staff_login_accounts_list', { p_tenant: A })).length, 2);
    assert.equal(await db.rpc(sindB, 'staff_login_accounts_list', { p_tenant: A }), null);
    const acts = (await db.sql("select action from audit_logs where tenant_id=$1 and action like 'staff_account.%' order by id", [A])).map((x) => x.action);
    assert.deepEqual(acts, ['staff_account.created', 'staff_account.created', 'staff_account.password_reset']);
    // Tabelas fechadas para o navegador; RPCs fechadas para anon.
    for (const tb of ['staff_account_requests', 'staff_login_accounts']) {
      const [p] = await db.sql(`select has_table_privilege('anon', $1, 'select,insert,update,delete,truncate') a, has_table_privilege('authenticated', $1, 'select,insert,update,delete,truncate') u`, [`public.${tb}`]);
      assert.deepEqual([p.a, p.u], [false, false], tb);
    }
    const fns = await db.sql(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, p.prosecdef d
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like any (array['app_staff_%', 'staff_login_%'])`);
    assert.equal(fns.length, 5);
    for (const f of fns) {
      assert.ok(f.d && !f.anon, `${f.proname}: definer, sem anon`);
      assert.equal(f.auth, !['app_staff_account_link', 'app_staff_password_changed'].includes(f.proname), `${f.proname}: authenticated`);
    }
  } finally { await db.raw.close(); }
});
