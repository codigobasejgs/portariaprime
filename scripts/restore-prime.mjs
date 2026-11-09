// Restaura um backup de scripts/backup-prime.mjs em Postgres ISOLADO (PGlite em memória,
// com as migrations canônicas) e confere contagens e checksums de objetos.
// Nunca escreve no projeto de origem. Serve como ensaio de restauração verificável.
// BACKUP_PASSPHRASE=... node scripts/restore-prime.mjs <arquivo.encrypted.json>
import { readFile } from 'node:fs/promises';
import { createDecipheriv, createHash, scryptSync } from 'node:crypto';
import { createDb } from '../tests/db/harness.mjs';

export function decryptBackup(text, passphrase) {
  const e = JSON.parse(text);
  const d = createDecipheriv('aes-256-gcm', scryptSync(passphrase, Buffer.from(e.salt, 'base64'), 32), Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64')), d.final()]).toString('utf8'));
}

// Ordem respeitando FKs; tabelas não listadas vão ao fim.
const ORDER = ['plans', 'plan_prices', 'plan_entitlements', 'privacy_terms_global', 'tenants', 'profiles', 'platform_admins', 'tenant_memberships',
  'tenant_branding', 'tenant_settings', 'tenant_integrations', 'units', 'unit_memberships', 'resident_contacts', 'invitations',
  'concierge_locations', 'storage_locations', 'device_enrollments', 'subscriptions', 'trial_eligibility', 'billing_orders',
  'payments', 'payment_events', 'billing_incidents', 'usage_counters', 'packages', 'package_events', 'package_attachments',
  'pickup_tokens', 'receipts', 'notifications', 'push_subscriptions', 'notification_jobs', 'notification_attempts',
  'consent_records', 'audit_logs', 'contact_requests'];

export async function restoreInto(db, bundle) {
  // Usuários Auth: só o inventário (sem senha) — recria identidades para as FKs; acesso exige reset de senha.
  for (const u of bundle.authInventory) {
    await db.sql('insert into auth.users (id, email, email_confirmed_at) values ($1,$2,$3) on conflict (id) do nothing', [u.id, u.email, u.email_confirmed_at]);
  }
  // Catálogo: a migration já semeia planos; o backup substitui pelo estado real.
  await db.raw.exec('set session_replication_role = replica');
  try {
    // Tabelas semeadas por migration (catálogo e configuração comercial) são substituídas pelo backup.
    // audit_logs: migrations também auditam (ex.: desconto por ciclo); o histórico real vem do backup.
    const seeded = ['plan_price_drafts', 'commercial_costs', 'commercial_scenarios', 'quote_policy', 'mdm_app_catalog', 'audit_logs', 'plan_entitlements', 'plan_prices', 'plans', 'profiles', 'privacy_terms_global', 'porter_terms'];
    for (const t of seeded) if (t in bundle.tables || ['plan_entitlements', 'plan_prices', 'plans', 'profiles'].includes(t)) await db.raw.exec(`delete from public.${t}`);
    const tables = [...ORDER.filter((t) => t in bundle.tables), ...Object.keys(bundle.tables).filter((t) => !ORDER.includes(t))];
    for (const t of tables) {
      for (const row of bundle.tables[t]) {
        const cols = Object.keys(row);
        await db.sql(
          `insert into public.${t} (${cols.map((c) => `"${c}"`).join(',')}) overriding system value
           select * from json_populate_record(null::public.${t}, $1::json)`,
          [JSON.stringify(row)],
        );
      }
    }
    for (const o of bundle.objects) {
      await db.sql('insert into storage.buckets (id, name, public) values ($1,$1,false) on conflict do nothing', [o.bucket]);
      await db.sql('insert into storage.objects (bucket_id, name) values ($1,$2) on conflict do nothing', [o.bucket, o.key]);
    }
  } finally {
    await db.raw.exec('set session_replication_role = origin');
  }
  const mismatches = [];
  for (const [t, expected] of Object.entries(bundle.counts)) {
    const [{ n }] = await db.sql(`select count(*)::int n from public.${t}`);
    if (n !== expected) mismatches.push(`${t}: esperado ${expected}, restaurado ${n}`);
  }
  for (const o of bundle.objects) {
    if (createHash('sha256').update(Buffer.from(o.base64, 'base64')).digest('hex') !== o.sha256) mismatches.push(`objeto ${o.key}: checksum`);
  }
  return mismatches;
}

if (process.argv[1]?.endsWith('restore-prime.mjs')) {
  const path = process.argv[2];
  if (!path || !process.env.BACKUP_PASSPHRASE) throw new Error('Informe arquivo e BACKUP_PASSPHRASE.');
  const text = await readFile(path, 'utf8');
  const expected = (await readFile(`${path}.sha256`, 'utf8')).trim();
  if (createHash('sha256').update(text).digest('hex') !== expected) throw new Error('Checksum do arquivo divergente.');
  const bundle = decryptBackup(text, process.env.BACKUP_PASSPHRASE);
  const db = await createDb();
  const mismatches = await restoreInto(db, bundle);
  if (mismatches.length) { console.error('RESTORE COM DIVERGÊNCIA:\n' + mismatches.join('\n')); process.exit(1); }
  const total = Object.values(bundle.counts).reduce((a, b) => a + b, 0);
  console.log(`Restore íntegro em Postgres isolado: ${Object.keys(bundle.counts).length} tabelas, ${total} linhas, ${bundle.objects.length} objetos, ${bundle.authInventory.length} identidades (sem senhas).`);
}
