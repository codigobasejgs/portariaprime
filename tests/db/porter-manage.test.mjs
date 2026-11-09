import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('porter-manage: síndico edita, troca senha e exclui porteiro; limites de escopo', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');
  // Como o PostgREST com login recente (amr), exigido por mdm_require_recent_auth.
  const fresh = async (uid, fn, args, recent = true) => {
    const keys = Object.keys(args);
    await db.raw.exec('begin');
    try {
      const amr = recent ? [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] : [];
      await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [uid, JSON.stringify({ sub: uid, amr })]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
      await db.raw.exec('commit');
      return r.rows[0].r;
    } catch (e) { await db.raw.exec('rollback'); throw e; }
  };
  const sind = await db.createUser('s@pm.invalid', { name: 'Síndica' });
  const sindB = await db.createUser('sb@pm.invalid', { name: 'Síndico B' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: slug, p_slug: slug, p_document: doc,
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
  const { tenant_id: A } = await prov(sind, 'pm-a', '11444777000161');
  const { tenant_id: B } = await prov(sindB, 'pm-b', '04252011000110');

  // Porteiro com biometria (como porter_signup_finish deixaria).
  const por = await db.createUser('p@pm.invalid', { name: 'Carlos' });
  const hash = (t, doc) => db.sql(`select app.sha256_hex($1) h`, [`${A}:${t}:${doc}`]).then((r) => r[0].h);
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [A, por]);
  await db.sql(`insert into porter_identities(tenant_id,user_id,full_name,document_type,document_hash,document_masked,phone) values($1,$2,'Carlos','CPF',$3,'CPF •••0000','11999990000')`,
    [A, por, await hash('CPF', '52998224725')]);
  await db.sql(`insert into porter_faces values($1,$2,$3,$4)`, [A, por, Array(128).fill(0.1), `${A}/staff-face/x.jpg`]);
  // Porteiro legado (sem biometria) e um morador.
  const leg = await db.createUser('l@pm.invalid', { name: 'Legado' });
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [A, leg]);

  // Lista: só quem tem 'team'.
  const list = await db.rpc(sind, 'porter_team_list', { p_tenant: A });
  assert.equal(list.length, 1); assert.equal(list[0].document_masked, 'CPF •••0000');
  assert.equal(await db.rpc(sindB, 'porter_team_list', { p_tenant: A }), null);

  // Editar: exige login recente; outro condomínio não alcança.
  await assert.rejects(fresh(sind, 'porter_update', { p_tenant: A, p_user: por, p_full_name: 'Carlos Silva' }, false), /Confirme sua senha/);
  await assert.rejects(fresh(sindB, 'porter_update', { p_tenant: A, p_user: por, p_full_name: 'X' }), /Somente quem gerencia/);
  await assert.rejects(fresh(sind, 'porter_update', { p_tenant: A, p_user: por, p_full_name: 'Carlos', p_document_type: 'CPF', p_document: '12345678900' }), /Documento inválido/);
  await fresh(sind, 'porter_update', { p_tenant: A, p_user: por, p_full_name: 'Carlos Silva', p_phone: '(11) 98888-7777', p_document_type: 'CPF', p_document: '111.444.777-35' });
  const [i] = await db.sql('select full_name, phone, document_hash, document_masked from porter_identities where user_id=$1', [por]);
  assert.deepEqual([i.full_name, i.phone, i.document_masked], ['Carlos Silva', '11988887777', 'CPF •••7735']);
  assert.equal(i.document_hash, await hash('CPF', '11144477735'), 'mesmo hash que o login do servidor calcula');
  const [{ full_name }] = await db.sql('select full_name from profiles where id=$1', [leg]);
  assert.equal(full_name, 'Legado');
  await fresh(sind, 'porter_update', { p_tenant: A, p_user: leg, p_full_name: 'Legado Novo' });
  assert.equal((await db.sql('select full_name from profiles where id=$1', [leg]))[0].full_name, 'Legado Novo');
  await assert.rejects(fresh(sind, 'porter_update', { p_tenant: A, p_user: leg, p_full_name: 'Legado Novo', p_document_type: 'CPF', p_document: '11144477735' }), /biométrico/);

  // Troca de senha: agora aceita porteiro com biometria; conta com vínculo em outro condomínio continua barrada.
  assert.equal((await fresh(sind, 'app_staff_password_check', { p_tenant: A, p_user: por })).user_id, por);
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [B, leg]);
  await assert.rejects(fresh(sind, 'porter_delete', { p_tenant: A, p_user: leg }), /outro vínculo/);
  await assert.rejects(fresh(sind, 'porter_update', { p_tenant: A, p_user: leg, p_full_name: 'Legado Outro' }), /outro vínculo/);
  // Síndico não se exclui; não exclui admin nem morador por aqui.
  await assert.rejects(fresh(sind, 'porter_delete', { p_tenant: A, p_user: sind }), /próprio acesso/);

  // Excluir: sai da equipe, referência facial vai para a fila de eliminação, auditoria registra.
  const res = await fresh(sind, 'porter_delete', { p_tenant: A, p_user: por });
  assert.equal(res.deleted, true);
  assert.equal((await db.sql('select count(*)::int n from tenant_memberships where user_id=$1', [por]))[0].n, 0);
  assert.equal((await db.sql('select count(*)::int n from porter_identities where user_id=$1', [por]))[0].n, 0);
  assert.equal((await db.sql('select count(*)::int n from porter_faces where user_id=$1', [por]))[0].n, 0);
  assert.equal((await db.sql(`select count(*)::int n from porter_photo_deletions where path=$1`, [`${A}/staff-face/x.jpg`]))[0].n, 1);
  const [{ n }] = await db.sql(`select count(*)::int n from audit_logs where action='porter.deleted' and target_id=$1`, [por]);
  assert.equal(n, 1);
  const [{ s }] = await db.as(por, 'select app.is_staff($1) s', [A]);
  assert.equal(s, false, 'excluído não opera mais');

  // Nada disso é chamável sem login.
  await assert.rejects(db.as(null, 'select public.porter_delete($1,$2)', [A, leg]), /permission denied/);
  await assert.rejects(db.as(null, 'select public.porter_team_list($1)', [A]), /permission denied/);
  await db.raw.close();
});
