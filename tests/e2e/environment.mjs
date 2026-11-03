// A ausência de clientes não torna produção um ambiente de testes.
// Política local: suítes mutáveis só podem usar uma stack Supabase de loopback.
export function assertLocalSupabase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('SUPABASE_URL inválida.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password) {
    throw new Error('E2E mutável bloqueado: use Supabase local isolado, nunca o projeto publicado.');
  }
}

/** CNPJ sintético com dígitos verificadores válidos (o onboarding confere). */
export function fakeCnpj(seed = Date.now()) {
  const b = String(seed).slice(-8).padStart(8, '1') + '0001';
  const dv = (s, w) => { const r = s.split('').reduce((a, c, i) => a + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(b, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return b + d1 + dv(b + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
}

/** Onboarding em etapas: dados → plano → revisão → ativação (página de sucesso → painel). */
export async function onboard(page, { name, slug, document }) {
  await page.getByLabel('Nome do condomínio').fill(name);
  await page.getByLabel(/Endereço no sistema/).fill(slug);
  await page.getByLabel(/CNPJ do condomínio/).fill(document);
  await page.getByRole('button', { name: 'Escolher o plano' }).click();
  await page.getByRole('button', { name: 'Revisar e ativar' }).click();
  await page.getByText('Primeiro mês grátis; depois').waitFor();
  await page.getByRole('checkbox').check(); // aceite explícito, nunca pré-marcado
  await page.getByRole('button', { name: 'Confirmar e ativar mês grátis' }).click();
  await page.getByRole('button', { name: 'Acessar meu painel' }).click();
}
