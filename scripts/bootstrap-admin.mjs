// Uso controlado: conta já existente e e-mail verificado. Não cria senhas.
// node --env-file=.env scripts/bootstrap-admin.mjs --email <email> --confirm-project <hostname>
import { createClient } from '@supabase/supabase-js';
const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
const email = process.argv.includes('--email') ? arg('--email').trim().toLowerCase() : '';
const url = process.env.SUPABASE_URL;
if (!email || !url || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Informe --email, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
if (!process.argv.includes('--confirm-project') || arg('--confirm-project') !== new URL(url).hostname) throw new Error('Confirme o destino com --confirm-project <hostname do projeto>.');
const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
let user;
for (let page = 1; ; page++) {
  const { data, error } = await client.auth.admin.listUsers({ page, perPage: 500 });
  if (error) throw error;
  user = data.users.find(u => u.email?.toLowerCase() === email);
  if (user || data.users.length < 500) break;
}
if (!user?.email_confirmed_at) throw new Error('Conta não encontrada ou e-mail não verificado.');
const { error } = await client.from('platform_admins').upsert({ user_id: user.id, note: 'Bootstrap controlado: identidade Auth com e-mail verificado.' }, { onConflict: 'user_id', ignoreDuplicates: true });
if (error) throw error;
console.log('Administrador da plataforma provisionado. Nenhuma senha criada ou alterada.');
