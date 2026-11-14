// WhatsApp do Portaria Prime IA por condomínio: tabela sem acesso de usuários; gate do painel exige 'team',
// plano com WhatsApp e senha recente para conectar/desconectar, e audita a ação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('assistant_channels: credenciais fora do alcance do usuário; gate por permissão, plano, senha recente e auditoria', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const gate = async (uid, tenant, action, recent = true) => {
    await db.raw.exec('begin');
    try {
      const amr = recent ? [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] : [];
      await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [uid, JSON.stringify({ sub: uid, amr })]);
      await db.raw.exec('set local role authenticated');
      const r = await db.raw.query('select public.assistant_channel_gate($1, $2) as r', [tenant, action]);
      await db.raw.exec('commit');
      return r.rows[0].r;
    } catch (e) { await db.raw.exec('rollback'); throw e; }
  };
  const sind = await db.createUser('s@ch.invalid', { name: 'Síndica' });
  const sindB = await db.createUser('b@ch.invalid', { name: 'Síndico B' });
  const por = await db.createUser('p@ch.invalid', { name: 'Porteiro' });
  const prov = (u, slug, doc, plan = 'prime') => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `C ${slug}`, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: plan, p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sind, 'ch-a', '11444777000161');
  const B = await prov(sindB, 'ch-b', '11222333000181');
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [A, por]);

  for (const role of ['authenticated', 'anon']) {
    const [p] = await db.sql(`select has_table_privilege($1, 'public.assistant_channels', 'select') s`, [role]);
    assert.equal(p.s, false, `${role} não lê token/segredo`);
  }
  await db.service(`insert into assistant_channels(tenant_id, instance, token, webhook_secret) values($1::uuid, 'ppia-' || $1::text, repeat('a', 64), repeat('b', 64))`, [A]);
  await assert.rejects(db.service(`insert into assistant_channels(tenant_id, instance, token, webhook_secret) values($1, 'agendafacil265', repeat('a', 64), repeat('b', 64))`, [B]), /check/,
    'só instâncias ppia-<uuid>');

  assert.equal(await gate(sind, A, 'status', false), true, 'ver status não pede senha');
  await assert.rejects(gate(sind, A, 'connect', false), /Confirme sua senha/);
  assert.equal(await gate(sind, A, 'connect'), true);
  assert.equal(await gate(sind, A, 'logout'), true);
  await assert.rejects(gate(por, A, 'status'), /gerencia a equipe/, 'porteiro não conecta');
  await assert.rejects(gate(sindB, A, 'connect'), /gerencia a equipe/, 'outro condomínio não conecta');
  await assert.rejects(gate(sind, A, 'apagar'), /Ação inválida/);
  const logs = await db.sql(`select action, actor_id from audit_logs where tenant_id = $1 and action like 'assistant.channel_%' order by id`, [A]);
  assert.deepEqual(logs.map((l) => l.action), ['assistant.channel_connect', 'assistant.channel_logout']);
  assert.ok(logs.every((l) => l.actor_id === sind));

  // Plano sem WhatsApp: bloqueado mesmo para o síndico.
  await db.sql(`update app.tenant_plan_limits set limits = limits || '{"feature_whatsapp": false}' where tenant_id = $1`, [A]);
  assert.equal((await db.sql('select feature_whatsapp f from app.entitlements($1)', [A]))[0].f, false);
  await assert.rejects(gate(sind, A, 'status'), /plano com WhatsApp/);
});
