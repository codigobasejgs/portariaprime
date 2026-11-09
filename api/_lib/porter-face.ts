/** Fixed face-api 1.7.15/dlib descriptor. Conservative pilot threshold, NOT measured FAR/FRR.
 * Browser embeddings/liveness are forgeable: password authentication remains mandatory.
 * Deployment calibration needs consented genuine/impostor pairs across cameras/light/demographics.
 */
export const FACE_THRESHOLD = 0.45;
export function validDescriptor(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 128 && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 2)
    && v.reduce((s, x) => s + x * x, 0) >= 0.01 && v.reduce((s, x) => s + x * x, 0) <= 25;
}
export function faceDistance(a: unknown, b: unknown): number | null {
  return validDescriptor(a) && validDescriptor(b) ? Math.hypot(...a.map((x, i) => x - b[i])) : null;
}
export function documentValue(type: unknown, value: unknown): string {
  if (!['CPF', 'RG', 'CNH'].includes(String(type)) || typeof value !== 'string') throw new Error('Documento inválido.');
  const v = value.toUpperCase().replace(/[.\s/-]/g, '');
  if (type === 'RG' ? !/^[A-Z0-9]{5,20}$/.test(v) : !/^\d{11}$/.test(v)) throw new Error('Documento inválido.');
  if (type === 'CPF') {
    if (/^(\d)\1+$/.test(v)) throw new Error('CPF inválido.');
    for (const n of [9, 10]) {
      const sum = [...v.slice(0, n)].reduce((s, x, i) => s + Number(x) * (n + 1 - i), 0);
      if ((sum * 10 % 11) % 10 !== Number(v[n])) throw new Error('CPF inválido.');
    }
  }
  return v;
}
