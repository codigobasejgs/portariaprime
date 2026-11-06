/**
 * Comprovante de entrega em PDF (A4), gerado no servidor com pdf-lib (JS puro,
 * cabe no runtime serverless). Entrada já autorizada e montada pelo worker:
 * nenhum recurso externo é buscado aqui. Três modelos com campos controlados.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';

// pdf-2: código de verificação + URL pública de validação (/validar). PDFs pdf-1 não são regenerados.
export const RECEIPT_TEMPLATE_VERSION = 'pdf-2';

export interface ReceiptLayout {
  template?: 'classico' | 'moderno' | 'compacto'; color_primary?: string; color_accent?: string;
  logo_position?: 'left' | 'center' | 'right'; logo_size?: 'small' | 'medium' | 'large';
  title?: string; message?: string | null; footer?: string | null; address?: string | null; contact?: string | null;
  show_address?: boolean; show_contact?: boolean; show_document?: boolean;
  tenant_name?: string; document?: string | null; timezone?: string; version?: number;
}
export interface ReceiptData {
  protocol: string; package_id: string; issued_at: string; recipient_name?: string | null;
  storage?: string | null; layout: ReceiptLayout;
  /** Código opaco do comprovante; `verify_url` = página pública /validar (montada pelo worker). */
  verify_code?: string | null; verify_url?: string | null;
  snapshot: {
    tracking_code?: string | null; carrier?: string; unit_block?: string | null; unit_label?: string;
    received_at?: string; picked_up_at?: string; picked_up_by?: string; operator?: string;
    method?: string; manual_reason?: string | null; recipient_kind?: string | null; storage?: string | null;
    /** Comprovantes a partir de 06/11/2026: quem recebeu na portaria, entregador e unidade com os rótulos do condomínio. */
    received_by_name?: string | null; courier_name?: string | null; unit_text?: string | null;
  };
}
export interface ReceiptAssets { logo?: Uint8Array | null; signature?: Uint8Array | null; photo?: Uint8Array | null }

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const hex = (h: string | undefined, d: string) => {
  const v = /^#[0-9A-Fa-f]{6}$/.test(h || '') ? h! : d;
  return rgb(parseInt(v.slice(1, 3), 16) / 255, parseInt(v.slice(3, 5), 16) / 255, parseInt(v.slice(5, 7), 16) / 255);
};
const luminance = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const fmt = (iso: string | undefined, tz: string) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '—';
const doc = (d: string) => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d;

/** Imagem só se o conteúdo for PNG/JPEG de verdade (assinatura de bytes); senão ignora. */
async function embed(pdf: PDFDocument, bytes?: Uint8Array | null): Promise<PDFImage | null> {
  if (!bytes || bytes.length < 8) return null;
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return await pdf.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await pdf.embedJpg(bytes);
  } catch { /* arquivo corrompido: segue sem a imagem */ }
  return null;
}
const fit = (img: PDFImage, w: number, h: number) => { const s = Math.min(w / img.width, h / img.height, 1.5); return { width: img.width * s, height: img.height * s }; };

export async function renderReceiptPdf(data: ReceiptData, assets: ReceiptAssets): Promise<Uint8Array> {
  const L = data.layout || {};
  const tpl = L.template || 'classico';
  const tz = L.timezone || 'America/Sao_Paulo';
  const primaryHex = /^#[0-9A-Fa-f]{6}$/.test(L.color_primary || '') ? L.color_primary! : '#101F30';
  const primary = hex(primaryHex, '#101F30');
  const accent = hex(L.color_accent, '#C8AB78');
  const ink = rgb(0.094, 0.157, 0.227), muted = rgb(0.32, 0.38, 0.45), line = rgb(0.87, 0.85, 0.81);
  const compact = tpl === 'compacto';
  const size = compact ? 9 : 10.5;

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Comprovante ${data.protocol}`); pdf.setProducer('Portaria Prime'); pdf.setCreator('Portaria Prime');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  // Fonte padrão (WinAnsi): caracteres fora dela viram "?" em vez de quebrar o PDF.
  const safe = (s: unknown) => Array.from(String(s ?? '').replace(/[\r\t]/g, ' ')).map((c) => (c === '\n' || charset.has(c.codePointAt(0)!) ? c : '?')).join('');
  const wrap = (text: string, f: PDFFont, sz: number, width: number) => {
    const out: string[] = [];
    for (const para of safe(text).split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        let w = word;
        while (f.widthOfTextAtSize(w, sz) > width) { // palavra maior que a linha (ex.: código longo)
          let k = w.length; while (k > 1 && f.widthOfTextAtSize(w.slice(0, k), sz) > width) k--;
          if (cur) { out.push(cur); cur = ''; }
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        const next = cur ? `${cur} ${w}` : w;
        if (f.widthOfTextAtSize(next, sz) > width) { out.push(cur); cur = w; } else cur = next;
      }
      out.push(cur);
    }
    return out;
  };

  const logo = await embed(pdf, assets.logo);
  const signature = await embed(pdf, assets.signature);
  const photo = await embed(pdf, assets.photo);

  let page: PDFPage = pdf.addPage(A4);
  const footerLines = L.footer ? wrap(L.footer, font, 8, A4[0] - 2 * M).slice(0, 3) : [];
  const bottom = M + 24 + footerLines.length * 10; // reservado ao rodapé
  let y = A4[1] - M;
  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - M; };
  const ensure = (h: number) => { if (y - h < bottom) newPage(); };
  const text = (s: string, x: number, yy: number, f = font, sz = size, color = ink) => page.drawText(s, { x, y: yy, size: sz, font: f, color });

  // Cabeçalho
  const name = L.tenant_name || 'Condomínio';
  const logoH = { small: 36, medium: 54, large: 72 }[L.logo_size || 'medium'] * (compact ? 0.8 : 1);
  const pos = L.logo_position || 'left';
  const W = A4[0] - 2 * M;
  const onBand = tpl === 'moderno';
  const headInk = onBand ? (luminance(primaryHex) > 0.4 ? ink : rgb(1, 1, 1)) : ink;
  const top = A4[1] - M + (onBand ? 12 : 0);
  const nameSize = compact ? 13 : 16;
  const dims = logo ? fit(logo, Math.min(200, W / 2), logoH) : null;
  const logoW = dims?.width || 0;
  const nameW = logo && pos !== 'center' ? W - logoW - 16 : W;
  const nameLines = wrap(name, bold, nameSize, nameW);
  if (nameLines.length > 3) nameLines.splice(2, Infinity, nameLines[2].replace(/\s*\S*$/, '') + '…');
  const extras = [L.show_address && L.address, L.show_contact && L.contact, L.show_document && L.document && `CNPJ/CPF ${doc(L.document)}`].filter(Boolean) as string[];
  const textH = nameLines.length * (nameSize + 3) + extras.length * 11;
  const headH = logo && pos === 'center' ? (dims!.height + 14 + textH) : Math.max(dims?.height || 0, textH);
  if (onBand) page.drawRectangle({ x: 0, y: top - headH - 24, width: A4[0], height: headH + 24 + M, color: primary });
  if (logo) {
    const d = dims!;
    const lx = pos === 'center' ? (A4[0] - d.width) / 2 : pos === 'right' ? A4[0] - M - d.width : M;
    if (onBand) page.drawRectangle({ x: lx - 6, y: top - d.height - 6, width: d.width + 12, height: d.height + 12, color: rgb(1, 1, 1) });
    page.drawImage(logo, { x: lx, y: top - d.height, ...d });
  }
  let ny = logo && pos === 'center' ? top - dims!.height - 14 - nameSize : top - nameSize;
  for (const ln of nameLines) {
    const w = bold.widthOfTextAtSize(ln, nameSize);
    const nx = pos === 'center' || !logo ? (pos === 'center' ? (A4[0] - w) / 2 : M) : pos === 'left' ? M + logoW + 16 : M;
    text(ln, nx, ny, bold, nameSize, headInk);
    ny -= nameSize + 3;
  }
  for (const e of extras) {
    const ln = wrap(e, font, 8.5, W)[0];
    const w = font.widthOfTextAtSize(ln, 8.5);
    const ex = pos === 'center' || !logo ? (pos === 'center' ? (A4[0] - w) / 2 : M) : pos === 'left' ? M + logoW + 16 : M;
    text(ln, ex, ny, font, 8.5, onBand ? headInk : muted); ny -= 11;
  }
  y = top - headH - (onBand ? 46 : 18);
  if (tpl === 'classico') { page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 2, color: accent }); y -= 20; }

  // Título e protocolo
  for (const ln of wrap(L.title || 'Comprovante de entrega de encomenda', bold, compact ? 13 : 15, W)) { ensure(20); text(ln, M, y, bold, compact ? 13 : 15, tpl === 'classico' ? primary : ink); y -= compact ? 16 : 19; }
  text(safe(`Protocolo ${data.protocol}`), M, y, bold, size, muted); y -= size + (compact ? 10 : 16);
  if (tpl === 'moderno') { page.drawRectangle({ x: M, y: y + 6, width: 48, height: 3, color: accent }); y -= 8; }

  // Tabela de dados
  const s = data.snapshot;
  const unit = s.unit_text || [s.unit_block ? `Bloco ${s.unit_block}` : null, s.unit_label].filter(Boolean).join(' · ') || '—';
  const reception = s.received_by_name || s.courier_name
    ? [['Recebido na portaria por', `${s.received_by_name || '—'}${s.courier_name ? ` (Entregador: ${s.courier_name})` : ''}`] as [string, string]] : [];
  const rows: [string, string][] = [
    ['Encomenda', data.package_id.slice(0, 8).toUpperCase()],
    ['Destinatário na etiqueta', data.recipient_name || '—'],
    ['Unidade', unit],
    ['Transportadora', s.carrier || '—'],
    ['Rastreio', s.tracking_code || '—'],
    ['Recebida na portaria', fmt(s.received_at, tz)],
    ...reception,
    ['Entregue em', fmt(s.picked_up_at, tz)],
    ['Entregue ao morador por', s.operator || 'Portaria'],
    ['Retirado por', s.picked_up_by || '—'],
    ['Condição', s.recipient_kind === 'autorizado' ? 'Terceiro autorizado' : 'Morador da unidade'],
    ['Local de guarda', s.storage || data.storage || '—'],
    ['Validação', s.method === 'qr' ? 'QR Code de uso único' : `Manual: ${s.manual_reason || 'justificada'}`],
  ];
  const labelW = compact ? 130 : 160;
  const rowGap = compact ? 4 : 7;
  rows.forEach(([k, v], i) => {
    const vl = wrap(v, font, size, W - labelW - 12);
    const h = vl.length * (size + 3) + rowGap;
    ensure(h + 4);
    if (tpl !== 'compacto' && i % 2 === 0) page.drawRectangle({ x: M - 6, y: y - h + size + 1, width: W + 12, height: h, color: tpl === 'moderno' ? rgb(0.965, 0.96, 0.95) : rgb(0.98, 0.975, 0.965) });
    text(safe(k), M, y, bold, size, muted);
    vl.forEach((ln, j) => text(ln, M + labelW, y - j * (size + 3)));
    y -= h;
    if (tpl === 'compacto') page.drawLine({ start: { x: M, y: y + size - 1 }, end: { x: A4[0] - M, y: y + size - 1 }, thickness: 0.4, color: line });
  });

  if (L.message) {
    y -= 8;
    for (const ln of wrap(L.message, font, size, W)) { ensure(size + 4); text(ln, M, y, font, size, ink); y -= size + 4; }
  }

  // Provas: assinatura e foto do item no momento da entrega (nunca omitidas para caber).
  y -= 12;
  const boxH = compact ? 120 : 170;
  const half = (W - 16) / 2;
  ensure(boxH + 30);
  text('Assinatura de quem retirou', M, y, bold, size, muted);
  text('Foto do item entregue', M + half + 16, y, bold, size, muted);
  y -= 8;
  for (const [img, x, label] of [[signature, M, 'Assinatura não disponível'], [photo, M + half + 16, 'Foto não disponível']] as const) {
    page.drawRectangle({ x, y: y - boxH, width: half, height: boxH, borderColor: line, borderWidth: 1, color: rgb(1, 1, 1) });
    if (img) { const d = fit(img, half - 12, boxH - 12); page.drawImage(img, { x: x + (half - d.width) / 2, y: y - boxH + (boxH - d.height) / 2, ...d }); }
    else text(label, x + 10, y - boxH / 2, font, size, muted);
  }
  y -= boxH + 14;
  for (const ln of wrap('Assinatura desenhada na tela para registro operacional; não é assinatura digital certificada.', font, 8, W)) { ensure(10); text(ln, M, y, font, 8, muted); y -= 10; }

  // Validação pública: só confirma existência, data da entrega e condomínio (sem dados pessoais).
  if (data.verify_code) {
    y -= 6; ensure(34);
    text(safe(`Código de verificação: ${data.verify_code}`), M, y, bold, size, ink); y -= size + 4;
    const how = data.verify_url ? `Confira a autenticidade em ${data.verify_url} informando o código acima.` : 'Confira a autenticidade na página /validar da Portaria Prime informando o código acima.';
    for (const ln of wrap(how, font, 8, W)) { ensure(10); text(ln, M, y, font, 8, muted); y -= 10; }
  }

  // Rodapé em todas as páginas (área reservada; não cobre conteúdo).
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    let fy = M + 14 + footerLines.length * 10;
    for (const ln of footerLines) { text(ln, M, fy, font, 8, muted); fy -= 10; }
    p.drawLine({ start: { x: M, y: M + 6 }, end: { x: A4[0] - M, y: M + 6 }, thickness: 0.5, color: line });
    text(safe(`Emitido pela Portaria Prime em ${fmt(data.issued_at, tz)} · ${data.protocol}`), M, M - 6, font, 7.5, muted);
    const pg = `Página ${i + 1} de ${pages.length}`;
    text(pg, A4[0] - M - font.widthOfTextAtSize(pg, 7.5), M - 6, font, 7.5, muted);
  });
  return pdf.save();
}
