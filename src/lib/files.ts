import { supabase } from './supabase';

/**
 * Re-encoda a imagem via canvas (remove metadados/EXIF e qualquer conteúdo
 * não-imagem) e limita o tamanho. Saída sempre JPEG/PNG gerado pelo navegador.
 */
export async function reencode(src: Blob | string, { max = 1600, type = 'image/jpeg', quality = 0.85 } = {}): Promise<Blob> {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error('Arquivo de imagem inválido.'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, type, quality));
    if (!blob) throw new Error('Não foi possível processar a imagem.');
    return blob;
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(url);
  }
}

export const blobToDataUrl = (b: Blob) =>
  new Promise<string>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => bad(r.error);
    r.readAsDataURL(b);
  });

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

/** Envia prova (foto/assinatura) ao bucket privado. Falha = erro explícito, sem fallback. */
export async function uploadPackageFile(tenantId: string, packageId: string, prefix: 'label_photo' | 'signature' | 'handover', blob: Blob) {
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `${tenantId}/packages/${packageId}/${prefix}-${rand()}.${ext}`;
  const { error } = await supabase.storage.from('tenant-private').upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw new Error('Falha ao enviar o arquivo. Verifique a conexão e tente novamente.');
  return path;
}

/** URL assinada curta, gerada sob demanda (nunca armazenada). */
export async function signedUrl(path: string, seconds = 300) {
  const { data, error } = await supabase.storage.from('tenant-private').createSignedUrl(path, seconds);
  if (error || !data) throw new Error('Arquivo indisponível ou sem permissão.');
  return data.signedUrl;
}

export async function uploadLogo(tenantId: string, file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use PNG, JPG ou WebP (SVG não é aceito).');
  if (file.size > 3 * 1024 * 1024) throw new Error('Logo muito grande (máx. 3 MB).');
  const blob = await reencode(file, { max: 600, type: 'image/png' });
  if (blob.size > 1024 * 1024) throw new Error('Logo muito detalhado; reduza a imagem.');
  const path = `${tenantId}/logo-${rand()}.png`;
  const { error } = await supabase.storage.from('tenant-public').upload(path, blob, { contentType: 'image/png' });
  if (error) throw new Error('Falha ao enviar o logo.');
  return path;
}
