import { ConfigError } from './env.js';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Lê JSON com limite de tamanho real (não confia em Content-Length). */
export async function readJson<T = any>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'Requisição grande demais.');
  try {
    return JSON.parse(new TextDecoder().decode(buf || new ArrayBuffer(0)) || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

/** Envolve o handler: erros previstos viram resposta clara; o resto não vaza detalhe interno. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof ConfigError) {
        console.error('[config]', e.message);
        return json({ error: e.message }, 503);
      }
      console.error('[api]', e?.message || e);
      return json({ error: 'Erro interno. Tente novamente.' }, 500);
    }
  };
}

export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação em tempo constante para segredos de job. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
