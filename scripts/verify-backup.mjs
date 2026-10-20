// Validação offline: autenticação AES-GCM, checksum externo e objetos.
// Não restaura registros nem acessa rede.
// BACKUP_PASSPHRASE=... node scripts/verify-backup.mjs <arquivo.encrypted.json>
import { readFile } from 'node:fs/promises';
import { createDecipheriv, createHash, scryptSync } from 'node:crypto';
const path = process.argv[2];
if (!path || !process.env.BACKUP_PASSPHRASE) throw new Error('Informe arquivo e BACKUP_PASSPHRASE.');
const text = await readFile(path, 'utf8');
const expected = (await readFile(`${path}.sha256`, 'utf8')).trim();
if (createHash('sha256').update(text).digest('hex') !== expected) throw new Error('Checksum do backup divergente.');
const envelope = JSON.parse(text);
const decipher = createDecipheriv('aes-256-gcm', scryptSync(process.env.BACKUP_PASSPHRASE, Buffer.from(envelope.salt, 'base64'), 32), Buffer.from(envelope.iv, 'base64'));
decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
for (const [table, rows] of Object.entries(data.tables)) {
  if (rows.length !== data.counts[table]) throw new Error(`Contagem divergente: ${table}`);
}
for (const object of data.objects) {
  if (createHash('sha256').update(Buffer.from(object.base64, 'base64')).digest('hex') !== object.sha256) throw new Error('Checksum de objeto divergente.');
}
console.log(`Backup íntegro: ${Object.keys(data.tables).length} tabelas, ${data.objects.length} objetos, ${data.authInventory.length} identidades inventariadas.`);
console.log('Integridade offline não substitui ensaio de restauração com Auth, Storage e Postgres reais.');
