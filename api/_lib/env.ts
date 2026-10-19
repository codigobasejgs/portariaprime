/**
 * Configuração do servidor. Variável obrigatória ausente = erro claro, sem
 * fallback para URL antiga nem valor inventado.
 */
export class ConfigError extends Error {}

export function env(name: string): string {
  const v = (process.env[name] || '').replace(/^["']|["']$/g, '').trim();
  if (!v) throw new ConfigError(`Variável de ambiente ${name} não configurada no servidor.`);
  return v;
}

export function optionalEnv(name: string): string | null {
  const v = (process.env[name] || '').replace(/^["']|["']$/g, '').trim();
  return v || null;
}

/** URL pública confiável do app (nunca derivada do Host da requisição). */
export function appUrl(): string {
  const u = new URL(env('APP_URL'));
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new ConfigError('APP_URL precisa usar https.');
  }
  return u.origin;
}
