// Backup lógico criptografado. Não modifica o projeto Supabase.
// node --env-file=.env scripts/backup-prime.mjs --output <diretório externo>
// BACKUP_PASSPHRASE: senha longa, fornecida no ambiente, nunca em argumento/log.
import { createClient } from '@supabase/supabase-js';
import { createCipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('Informe --output <diretório externo>.');
const passphrase = process.env.BACKUP_PASSPHRASE;
if (!passphrase || passphrase.length < 20) throw new Error('BACKUP_PASSPHRASE precisa ter pelo menos 20 caracteres.');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const root = new URL('../', import.meta.url);
const migrationsDir = new URL('supabase/migrations/', root);
const names = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(names.map(async name => ({ name, sql: await readFile(new URL(name, migrationsDir), 'utf8') })));
const tables = [...new Set(migrations.flatMap(m => [...m.sql.matchAll(/create table public\.(\w+)/gi)].map(match => match[1])))];
const bundle = { format: 1, createdAt: new Date().toISOString(), source: new URL(process.env.SUPABASE_URL).hostname, migrations, tables: {}, authInventory: [], objects: [], counts: {} };
const check = ({ data, error }) => { if (error) throw error; return data; };
for (const table of tables) {
  const rows = [];
  const order = table === 'platform_admins' ? 'user_id' : table === 'trial_eligibility' ? 'key' : ['tenant_branding', 'tenant_settings', 'tenant_integrations', 'usage_counters'].includes(table) ? 'tenant_id' : table === 'plan_entitlements' ? 'plan_id' : 'id';
  for (let offset = 0; ; offset += 500) {
    let query = client.from(table).select('*').order(order);
    if (table === 'tenant_integrations') query = query.order('provider');
    if (table === 'usage_counters') query = query.order('metric').order('period');
    const page = check(await query.range(offset, offset + 499));
    rows.push(...page);
    if (page.length < 500) break;
  }
  bundle.tables[table] = rows; bundle.counts[table] = rows.length;
  console.log(`${table}: ${rows.length}`);
}
for (let page = 1; ; page++) {
  const data = check(await client.auth.admin.listUsers({ page, perPage: 500 }));
  bundle.authInventory.push(...data.users.map(u => ({ id: u.id, email: u.email, email_confirmed_at: u.email_confirmed_at, created_at: u.created_at })));
  if (data.users.length < 500) break;
}
async function collect(bucket, prefix = '') {
  for (let offset = 0; ; offset += 100) {
    const entries = check(await client.storage.from(bucket).list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }));
    for (const entry of entries) {
      const key = [prefix, entry.name].filter(Boolean).join('/');
      if (!entry.id) { await collect(bucket, key); continue; }
      const blob = check(await client.storage.from(bucket).download(key));
      const bytes = Buffer.from(await blob.arrayBuffer());
      bundle.objects.push({ bucket, key, type: blob.type, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
    }
    if (entries.length < 100) break;
  }
}
for (const bucket of check(await client.storage.listBuckets())) await collect(bucket.id);
// ponytail: backup em memória; substituir por stream quando o acervo exceder a RAM disponível.
const plaintext = Buffer.from(JSON.stringify(bundle));
const salt = randomBytes(16), iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const payload = JSON.stringify({ format: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') });
const directory = resolve(process.argv[outputIndex + 1]);
await mkdir(directory, { recursive: true });
const path = resolve(directory, `prime-${bundle.createdAt.replace(/[:.]/g, '-')}.encrypted.json`);
await writeFile(path, payload, { flag: 'wx', mode: 0o600 });
await writeFile(`${path}.sha256`, createHash('sha256').update(payload).digest('hex'), { flag: 'wx' });
console.log(`Backup criptografado concluído: ${path}`);
console.log('Inventário Auth não contém senhas/sessões. Exportação paginada não é snapshot transacional; executar com escritas suspensas.');
