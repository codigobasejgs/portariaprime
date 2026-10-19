// Sobe um Postgres em memória (PGlite) com as migrations canônicas e oferece
// helpers para agir como um usuário comum (papel authenticated + JWT sub),
// exatamente como o PostgREST faz. Sem service role nos testes de isolamento.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function createDb({ seed = false } = {}) {
  const db = new PGlite();
  await db.exec(readFileSync(join(root, 'tests/db/supabase-shim.sql'), 'utf8'));
  const dir = join(root, 'supabase/migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${f} falhou: ${e.message}`);
    }
  }
  await db.exec(`insert into app.config values ('test_clock', 'on')`);
  if (seed) await db.exec(readFileSync(join(root, 'supabase/seed/demo.sql'), 'utf8'));
  return wrap(db);
}

function wrap(db) {
  let clock = null;
  const api = {
    raw: db,
    setNow(iso) { clock = iso; },
    async sql(text, params = []) { return (await db.query(text, params)).rows; },
    async createUser(email, { verified = true, name } = {}) {
      const [u] = await api.sql(
        `insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3) returning id`,
        [email, verified ? new Date().toISOString() : null, JSON.stringify({ full_name: name || email.split('@')[0] })]);
      return u.id;
    },
    // Executa como usuário autenticado (ou anon se uid = null), em transação isolada.
    async as(uid, text, params = []) {
      await db.exec('begin');
      try {
        await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
        if (clock) await db.query(`select set_config('app.test_now', $1, true)`, [clock]);
        await db.exec(uid ? 'set local role authenticated' : 'set local role anon');
        const r = await db.query(text, params);
        await db.exec('commit');
        return r.rows;
      } catch (e) {
        await db.exec('rollback');
        throw e;
      }
    },
    async service(text, params = []) {
      await db.exec('begin');
      try {
        if (clock) await db.query(`select set_config('app.test_now', $1, true)`, [clock]);
        await db.exec('set local role service_role');
        const r = await db.query(text, params);
        await db.exec('commit');
        return r.rows;
      } catch (e) { await db.exec('rollback'); throw e; }
    },
    rpc(uid, fn, args = {}) {
      const keys = Object.keys(args);
      const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      return api.as(uid, call, keys.map((k) => args[k])).then((rows) => rows[0].r);
    },
  };
  return api;
}
