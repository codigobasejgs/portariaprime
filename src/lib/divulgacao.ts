// Central de divulgação: modelos de cartaz/comunicado com o QR e o link PÚBLICOS do condomínio.
// Nenhum segredo entra no QR: só https://{host}/c/{slug} (o portal exige login e aprovação).
import QRCode from 'qrcode';

export type Model = 'cartaz' | 'comunicado' | 'whatsapp' | 'elevador';
export interface Texts { title: string; subtitle: string; body: string; cta: string }
export interface Brand { name: string; color: string; logo: HTMLImageElement | null }

export const MODELS: { id: Model; label: string; desc: string; size: [number, number] }[] = [
  { id: 'cartaz', label: 'Cartaz A4', desc: 'Mural, portaria e áreas comuns.', size: [1240, 1754] },
  { id: 'comunicado', label: 'Comunicado A4', desc: 'Circular com orientações passo a passo.', size: [1240, 1754] },
  { id: 'elevador', label: 'Elevador (A5)', desc: 'Formato compacto para elevador e hall.', size: [874, 1240] },
  { id: 'whatsapp', label: 'WhatsApp / Instagram', desc: 'Imagem quadrada para grupos e redes.', size: [1080, 1080] },
];

export const LIMITS: Record<keyof Texts, number> = { title: 120, subtitle: 240, body: 1200, cta: 240 };

export function defaults(model: Model, name: string): Texts {
  const base = { cta: 'Aponte a câmera do celular para o QR Code' };
  switch (model) {
    case 'cartaz': return { ...base, title: 'Suas encomendas no celular', subtitle: `${name} agora usa o Portaria Prime`,
      body: 'Receba aviso quando uma encomenda chegar e retire na portaria com um QR Code de uso único.' };
    case 'comunicado': return { ...base, title: 'Comunicado aos moradores', subtitle: `Novo controle de encomendas — ${name}`,
      body: '1. Aponte a câmera para o QR Code ou abra o link abaixo.\n2. Crie sua conta e informe bloco e unidade.\n3. Leia o termo de dados e envie o cadastro.\n4. Após a aprovação da administração, você passa a receber os avisos.\nDúvidas: fale com a portaria ou a administração.' };
    case 'elevador': return { ...base, title: 'Encomenda chegou?', subtitle: 'Saiba pelo celular', body: `Cadastre-se no portal do ${name}.` };
    case 'whatsapp': return { ...base, title: 'Portal dos moradores', subtitle: name, body: 'Avisos de encomendas e retirada segura com QR Code.', cta: 'Acesse e crie sua conta' };
  }
}

/** Texto efetivo: personalizado (salvo) quando houver, senão o padrão. */
export const effective = (model: Model, name: string, saved?: Partial<Texts> | null): Texts => ({ ...defaults(model, name), ...cleanTexts(saved || {}) });

/** Remove vazios e corta nos limites; recusa < e > (mesma regra do banco). */
export function cleanTexts(t: Partial<Texts>): Partial<Texts> {
  const out: Partial<Texts> = {};
  for (const k of Object.keys(LIMITS) as (keyof Texts)[]) {
    const v = (t[k] || '').trim();
    if (v) out[k] = v.replace(/[<>]/g, '').slice(0, LIMITS[k]);
  }
  return out;
}

/** Link público canônico do condomínio (o mesmo do PortalCard). */
export const portalLink = (origin: string, slug: string) => `${origin.replace(/\/+$/, '')}/c/${slug}`;

/** Garante que o QR leve só o endereço público do portal: nada de query, hash, token ou convite. */
export function assertPublicLink(link: string) {
  const u = new URL(link);
  if (u.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) throw new Error('O link do portal precisa ser HTTPS.');
  if (!/^\/c\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(u.pathname) || u.search || u.hash || u.username || u.password) throw new Error('O QR só pode conter o endereço público do portal.');
  return link;
}

/** Mensagem pronta para WhatsApp/e-mail. */
export const shareMessage = (t: Texts, name: string, link: string) => `*${t.title}* — ${name}\n${t.body}\n\nAcesse: ${link}`;
export const whatsappUrl = (msg: string) => `https://wa.me/?text=${encodeURIComponent(msg)}`;

/** Quebra o texto em linhas que cabem na largura (respeita \n). */
export function wrap(measure: (s: string) => number, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (measure(next) <= width || !cur) cur = next; else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
/** Cor de texto legível sobre a cor do condomínio (contraste WCAG). */
export const onColor = (hex: string) => (HEX.test(hex) && lum(hex) > 0.4 ? '#101F30' : '#FFFFFF');
export const safeColor = (hex?: string | null) => (hex && HEX.test(hex) ? hex : '#101F30');

/** Desenha o material no canvas (mesmo desenho usado para PNG e PDF). */
export function draw(ctx: CanvasRenderingContext2D, model: Model, t: Texts, brand: Brand, link: string) {
  const [W, H] = MODELS.find((m) => m.id === model)!.size;
  const color = safeColor(brand.color), fg = onColor(color);
  const pad = Math.round(W * 0.07);
  const font = (px: number, weight = 400) => `${weight} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.canvas.width = W; ctx.canvas.height = H;
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);

  // Faixa com a marca.
  const band = Math.round(H * (model === 'whatsapp' ? 0.2 : 0.16));
  ctx.fillStyle = color; ctx.fillRect(0, 0, W, band);
  let x = pad;
  const logoSize = Math.round(band * 0.6);
  if (brand.logo) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(pad, (band - logoSize) / 2, logoSize, logoSize);
    const r = Math.min(logoSize / brand.logo.width, logoSize / brand.logo.height) * 0.86;
    const lw = brand.logo.width * r, lh = brand.logo.height * r;
    ctx.drawImage(brand.logo, pad + (logoSize - lw) / 2, (band - lh) / 2, lw, lh);
    x += logoSize + Math.round(pad * 0.5);
  }
  ctx.fillStyle = fg; ctx.textBaseline = 'middle';
  const nameSize = Math.round(band * 0.24);
  ctx.font = font(nameSize, 700);
  const nameLines = wrap((s) => ctx.measureText(s).width, brand.name, W - x - pad).slice(0, 2);
  nameLines.forEach((l, i) => ctx.fillText(l, x, band / 2 + (i - (nameLines.length - 1) / 2) * nameSize * 1.15));

  // Textos.
  let y = band + Math.round(H * 0.05);
  ctx.textBaseline = 'top'; ctx.fillStyle = '#101F30';
  const block = (text: string, size: number, weight: number, color2: string, gap: number, max = 99) => {
    ctx.font = font(size, weight); ctx.fillStyle = color2;
    const lines = wrap((s) => ctx.measureText(s).width, text, W - 2 * pad).slice(0, max);
    for (const l of lines) { ctx.fillText(l, pad, y); y += size * 1.25; }
    y += gap;
  };
  const S = W / 1240;
  block(t.title, Math.round((model === 'whatsapp' ? 78 : 84) * S), 800, '#101F30', 18 * S, 3);
  block(t.subtitle, Math.round(44 * S), 600, color === '#FFFFFF' ? '#101F30' : color, 26 * S, 2);
  block(t.body, Math.round((model === 'comunicado' ? 36 : 40) * S), 400, '#334155', 30 * S, model === 'comunicado' ? 12 : 6);

  // QR + chamada + link (sempre no rodapé, tamanho fixo e legível para câmera).
  const qrSize = Math.round(Math.min(W * (model === 'whatsapp' ? 0.36 : 0.42), H - y - 260 * S));
  const footer = Math.round(150 * S);
  const qy = Math.max(y, H - footer - qrSize - 60 * S);
  const qx = Math.round((W - qrSize) / 2);
  const qr = QRCode.create(assertPublicLink(link), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size, quiet = 4, cell = qrSize / (n + quiet * 2);
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(qx, qy, qrSize, qrSize);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) ctx.fillRect(qx + (c + quiet) * cell, qy + (r + quiet) * cell, Math.ceil(cell), Math.ceil(cell));
  ctx.strokeStyle = '#E2E8F0'; ctx.lineWidth = Math.max(2, 3 * S); ctx.strokeRect(qx, qy, qrSize, qrSize);
  ctx.textAlign = 'center'; ctx.fillStyle = '#101F30';
  ctx.font = font(Math.round(36 * S), 700); ctx.fillText(t.cta, W / 2, qy + qrSize + 20 * S);
  ctx.font = font(Math.round(30 * S), 500); ctx.fillStyle = '#334155';
  ctx.fillText(link.replace(/^https?:\/\//, ''), W / 2, qy + qrSize + 66 * S);
  ctx.font = font(Math.round(22 * S), 400); ctx.fillStyle = '#64748B';
  ctx.fillText('Cadastro sujeito à aprovação da administração · Tecnologia Portaria Prime', W / 2, H - 50 * S);
  ctx.textAlign = 'left';
}

/** PNG do canvas. */
export const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Não foi possível gerar a imagem.'))), 'image/png'));

/** PDF A4/A5 com a imagem do material em alta resolução (pdf-lib carregado só aqui). */
export async function toPdf(canvas: HTMLCanvasElement, model: Model, title: string) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setProducer('Portaria Prime');
  const png = await doc.embedPng(new Uint8Array(await (await toPng(canvas)).arrayBuffer()));
  // Pontos: A4 = 595×842; A5 = 420×595; quadrado do WhatsApp em página A4 centralizado.
  const [pw, ph] = model === 'elevador' ? [420, 595] : [595, 842];
  const page = doc.addPage([pw, ph]);
  const r = Math.min(pw / png.width, ph / png.height);
  page.drawImage(png, { x: (pw - png.width * r) / 2, y: (ph - png.height * r) / 2, width: png.width * r, height: png.height * r });
  return doc.save();
}

export const fileName = (slug: string, model: Model, ext: 'png' | 'pdf') => `divulgacao-${slug}-${model}.${ext}`;
