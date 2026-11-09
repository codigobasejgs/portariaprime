import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('porter-identity: link, biometria opt-in, turno 12h, legados intactos, auditoria', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');

  let clockIso = null;
  const setClock = (d) => {
    clockIso = d instanceof Date ? d.toISOString() : d;
    db.setNow(clockIso);
  };

  // Helper de autenticação recente com session_id
  const fresh = async (uid, sessionId, fn, args) => {
    const keys = Object.keys(args);
    await db.raw.exec('begin');
    try {
      await db.raw.query(
        `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
        [uid, JSON.stringify({ sub: uid, session_id: sessionId, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]
      );
      if (clockIso) await db.raw.query(`select set_config('app.test_now', $1, true)`, [clockIso]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query(
        `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`,
        keys.map((k) => args[k])
      );
      await db.raw.exec('commit');
      return r.rows[0].r;
    } catch (e) {
      await db.raw.exec('rollback');
      throw e;
    }
  };

  const asUser = async (uid, sessionId, sqlText, params = []) => {
    await db.raw.exec('begin');
    try {
      await db.raw.query(
        `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
        [uid, JSON.stringify({ sub: uid, session_id: sessionId })]
      );
      if (clockIso) await db.raw.query(`select set_config('app.test_now', $1, true)`, [clockIso]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query(sqlText, params);
      await db.raw.exec('commit');
      return r.rows;
    } catch (e) {
      await db.raw.exec('rollback');
      throw e;
    }
  };

  const sindA = await db.createUser('sinda@cond-a.invalid', { name: 'Síndica A' });
  const sindB = await db.createUser('sindb@cond-b.invalid', { name: 'Síndico B' });
  const { tenant_id: A } = await db.rpc(sindA, 'provision_tenant', {
    p_request_id: crypto.randomUUID(), p_name: 'Cond A', p_slug: 'cond-a',
    p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly'
  });
  const { tenant_id: B } = await db.rpc(sindB, 'provision_tenant', {
    p_request_id: crypto.randomUUID(), p_name: 'Cond B', p_slug: 'cond-b',
    p_document: '04252011000110', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly'
  });

  // 1. Geração de link pelo síndico
  await assert.rejects(
    db.rpc(sindA, 'porter_link_create', { p_tenant: A, p_approval: false, p_hours: 24, p_uses: 1 }),
    /Confirme sua senha/
  );
  const linkA = await fresh(sindA, 'sess-sind-a', 'porter_link_create', { p_tenant: A, p_approval: false, p_hours: 24, p_uses: 1 });
  assert.equal(typeof linkA.token, 'string');
  assert.equal(linkA.token.length, 64);

  // Síndico de B não cria em A
  await assert.rejects(
    fresh(sindB, 'sess-sind-b', 'porter_link_create', { p_tenant: A, p_approval: false, p_hours: 24, p_uses: 1 }),
    /Sem permissão/
  );

  // 2. Preview do link (service)
  const prev = await db.service('select public.porter_signup_preview($1, $2) r', ['cond-a', linkA.token]).then((r) => r[0].r);
  assert.equal(prev.tenant_id, A);
  assert.equal(prev.name, 'Cond A');
  assert.equal(prev.term.version, '2026-11-09.1');

  // Preview com token incorreto ou outro slug
  await assert.rejects(
    db.service('select public.porter_signup_preview($1, $2) r', ['cond-b', linkA.token]),
    /Link inválido/
  );

  // 3. Cadastro do porteiro (service)
  const porteiro = await db.createUser('porteiro@cond-a.invalid', { name: 'Carlos Porteiro' });
  const descRef = Array(128).fill(0.1);
  const photoRef = `${A}/staff-face/${crypto.randomUUID()}.jpg`;
  const docHash = 'a'.repeat(64);

  // Rejeita termo adulterado
  await assert.rejects(
    db.service('select public.porter_signup_finish($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      'cond-a', linkA.token, porteiro,
      JSON.stringify({ fullName: 'Carlos Porteiro', documentType: 'CPF', documentHash: docHash, documentMasked: 'CPF •••1234', phone: '11999998888' }),
      descRef, photoRef, 'termo_errado', '127.0.0.1', 'test'
    ]),
    /termo biométrico/
  );

  // Sucesso
  const finish = await db.service('select public.porter_signup_finish($1, $2, $3, $4, $5, $6, $7, $8, $9) r', [
    'cond-a', linkA.token, porteiro,
    JSON.stringify({ fullName: 'Carlos Porteiro', documentType: 'CPF', documentHash: docHash, documentMasked: 'CPF •••1234', phone: '11999998888' }),
    descRef, photoRef, prev.term.hash, '127.0.0.1', 'test'
  ]).then((r) => r[0].r);
  assert.equal(finish.status, 'active');

  // Link consumido (max_uses=1): segundo uso rejeitado
  const porteiro2 = await db.createUser('p2@cond-a.invalid', { name: 'P2' });
  await assert.rejects(
    db.service('select public.porter_signup_finish($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      'cond-a', linkA.token, porteiro2,
      JSON.stringify({ fullName: 'P2', documentType: 'CPF', documentHash: 'b'.repeat(64), documentMasked: 'CPF •••5678', phone: '11999998888' }),
      descRef, photoRef, prev.term.hash, '127.0.0.1', 'test'
    ]),
    /Link inválido, expirado ou utilizado/
  );

  // 4. Porteiro cadastrado SEM turno ativo NÃO é staff
  const staffSemTurno = await asUser(porteiro, 'sess-1', 'select app.is_staff($1) ok', [A]).then((r) => r[0].ok);
  assert.equal(staffSemTurno, false);

  // 5. Legado (porteiro sem registro biométrico) É staff normalmente
  const legacyPorteiro = await db.createUser('legado@cond-a.invalid', { name: 'Porteiro Antigo' });
  await db.service("insert into tenant_memberships(tenant_id, user_id, role, status) values($1, $2, 'porteiro', 'active')", [A, legacyPorteiro]);
  const legacyStaff = await asUser(legacyPorteiro, 'sess-legado', 'select app.is_staff($1) ok', [A]).then((r) => r[0].ok);
  assert.equal(legacyStaff, true);

  // 6. Admin é sempre staff
  const adminStaff = await asUser(sindA, 'sess-sind', 'select app.is_staff($1) ok', [A]).then((r) => r[0].ok);
  assert.equal(adminStaff, true);

  // 7. Comparação facial no login (service)
  // Rosto igual (distância 0 <= 0.45)
  const checkOk = await db.service('select public.porter_login_check($1, $2, $3, $4, $5, $6) r', [
    A, porteiro, docHash, descRef, null, 'face'
  ]).then((r) => r[0].r);
  assert.equal(checkOk.ok, true);
  assert.equal(checkOk.result, 'ok');

  // Rosto diferente (distância > 0.45)
  const descDiff = Array(128).fill(0.1);
  descDiff[0] = 0.6; // diff = 0.5 > 0.45
  const checkMismatch = await db.service('select public.porter_login_check($1, $2, $3, $4, $5, $6) r', [
    A, porteiro, docHash, descDiff, null, 'face'
  ]).then((r) => r[0].r);
  assert.equal(checkMismatch.ok, false);
  assert.equal(checkMismatch.result, 'mismatch');

  // 8. Abertura do turno de 12 horas
  const shift = await db.service('select public.porter_shift_open($1, $2) r', [checkOk.attempt_id, 'sess-porteiro-1']).then((r) => r[0].r);
  assert.ok(shift.started_at);
  assert.ok(shift.expires_at);

  // Agora com o session_id correto, é staff!
  const staffComTurno = await asUser(porteiro, 'sess-porteiro-1', 'select app.is_staff($1) ok', [A]).then((r) => r[0].ok);
  assert.equal(staffComTurno, true);

  // Com outro session_id (sessão roubada / outro aparelho): NÃO é staff!
  const staffOutraSessao = await asUser(porteiro, 'sess-porteiro-2', 'select app.is_staff($1) ok', [A]).then((r) => r[0].ok);
  assert.equal(staffOutraSessao, false);

  // 9. Expiração do turno aos 12h: setClock avança 12h e 1 minuto
  const t0 = new Date();
  const t12h = new Date(t0.getTime() + 12 * 3600000 + 60000);
  setClock(t12h);

  const staffExpirado = await asUser(porteiro, 'sess-porteiro-1', 'select app.is_staff($1) ok', [A]).then((r) => r[0].ok);
  assert.equal(staffExpirado, false);

  // Admin continua staff mesmo com relógio avançado
  const adminApos12h = await asUser(sindA, 'sess-sind', 'select app.is_staff($1) ok', [A]).then((r) => r[0].ok);
  assert.equal(adminApos12h, true);

  // Volta o relógio
  setClock(t0);

  // 10. Bloqueio após 5 falhas em 15 minutos
  for (let i = 0; i < 5; i++) {
    await db.service('select public.porter_login_check($1, $2, $3, $4, $5, $6)', [A, porteiro, docHash, descDiff, null, 'face']);
  }
  const checkBlocked = await db.service('select public.porter_login_check($1, $2, $3, $4, $5, $6) r', [
    A, porteiro, docHash, descRef, null, 'face'
  ]).then((r) => r[0].r);
  assert.equal(checkBlocked.ok, false);
  assert.equal(checkBlocked.result, 'blocked');

  // 11. Auditoria e re-enrollment
  const audit = await db.rpc(sindA, 'porter_audit', { p_tenant: A });
  assert.equal(audit.porters.length, 2); // 1 biométrico + 1 legado
  assert.ok(audit.attempts.length >= 6);

  // Porteiro comum não lê auditoria
  await assert.rejects(
    db.rpc(porteiro, 'porter_audit', { p_tenant: A }),
    /Sem permissão/
  );

  // Recadastro de referência pelo síndico (auditado)
  await fresh(sindA, 'sess-sind-a', 'porter_reference_reset', { p_tenant: A, p_user: porteiro, p_reason: 'Troca de óculos e nova fisionomia' });
  const [ident] = await db.sql('select reenroll_until from porter_identities where user_id=$1', [porteiro]);
  assert.ok(ident.reenroll_until);

  // Janela de bloqueio de 15 minutos passa
  setClock(new Date(Date.now() + 16 * 60000));

  // Próximo login do porteiro cadastra a nova referência
  const novoDesc = Array(128).fill(0.2);
  const novaFoto = `${A}/staff-face/${crypto.randomUUID()}.jpg`;
  const reenrollCheck = await db.service('select public.porter_login_check($1, $2, $3, $4, $5, $6) r', [
    A, porteiro, docHash, novoDesc, novaFoto, 'face'
  ]).then((r) => r[0].r);
  assert.equal(reenrollCheck.ok, true);
  assert.equal(reenrollCheck.result, 'ok');

  // A nova referência é gravada no banco
  const [novaFace] = await db.sql('select descriptor from porter_faces where user_id=$1', [porteiro]);
  assert.equal(novaFace.descriptor[0], 0.2);
});
