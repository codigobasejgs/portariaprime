// Rota de acessos da equipe: regra de senha e recusa antes de qualquer chamada externa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem } from '../../api/team/[action].ts';
import { createApiServer } from '../../scripts/dev-api.mjs';

test('senha do acesso: tamanho, letras e números, nada trivial', () => {
  for (const ok of ['Portaria2026x', 'turnonoite123']) assert.equal(passwordProblem(ok), null, ok);
  for (const bad of [undefined, '', 'curta1', 'sóletrasaqui', '12345678901', 'aaaaaaaaaaaa1'.slice(0, 1).repeat(12), '1234567890ab', 'x'.repeat(70) + '12345']) {
    assert.ok(passwordProblem(bad), String(bad));
  }
});

test('rota recusa dados inválidos e sessão ausente (JSON, sem cache)', async () => {
  const server = createApiServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (a, body, h = {}) => fetch(`${base}/api/team/${a}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
  try {
    const t = '00000000-0000-4000-8000-000000000000';
    assert.equal((await post('create', { tenantId: 'x', password: 'Portaria2026x' })).status, 400);
    const weak = await post('create', { tenantId: t, password: 'fraca' });
    assert.equal(weak.status, 400);
    assert.match((await weak.json()).error, /10 caracteres/);
    const noAuth = await post('create', { tenantId: t, email: 'a@b.cc', fullName: 'Aa', role: 'porteiro', password: 'Portaria2026x' });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/api/team/create`)).status, 405);
  } finally { await new Promise((r) => server.close(r)); }
});
