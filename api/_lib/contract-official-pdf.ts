/**
 * PDF oficial do contrato v1.0 já preenchido (vai para a Autentique). A última página é a de
 * assinaturas, com dois blocos fixos; as posições devolvidas são as que a Autentique usa para
 * carimbar a assinatura de cada parte (x/y em % da página, z = número da página).
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

const A4: [number, number] = [595.28, 841.89];
const M = 56;

export type Positions = { contractor: { x: string; y: string; z: number }[]; owner: { x: string; y: string; z: number }[] };

export async function renderOfficialContract(text: string, parties: { contractor: string; contractorDoc: string; owner: string }):
  Promise<{ bytes: Uint8Array; positions: Positions }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Contrato Portaria Prime v1.0'); pdf.setProducer('Portaria Prime'); pdf.setCreator('Portaria Prime');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const safe = (s: string) => Array.from(s.replace(/[\r\t]/g, ' ').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'"))
    .map((c) => (c === '\n' || charset.has(c.codePointAt(0)!) ? c : '?')).join('');
  const ink = rgb(0.094, 0.157, 0.227), muted = rgb(0.32, 0.38, 0.45);
  const W = A4[0] - 2 * M;
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const ensure = (h: number) => { if (y - h < M + 20) { page = pdf.addPage(A4); y = A4[1] - M; } };
  const wrap = (s: string, f: PDFFont, sz: number, width = W) => {
    const out: string[] = []; let cur = '';
    for (const word of safe(s).split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (f.widthOfTextAtSize(next, sz) > width && cur) { out.push(cur); cur = word; } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  };
  const para = (s: string, f = font, sz = 9.5, indent = 0, color = ink) => {
    for (const ln of wrap(s, f, sz, W - indent)) { ensure(sz + 4); page.drawText(ln, { x: M + indent, y, size: sz, font: f, color }); y -= sz + 4; }
  };
  const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1');

  // Corpo (para antes do bloco de assinaturas do texto; a página de assinaturas é desenhada abaixo).
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sigStart = lines.findIndex((l) => /^\*\*CONTRATADA:\*\*$/.test(l.trim()));
  const sigEnd = lines.findIndex((l, i) => i > sigStart && /^Dispensa legal de testemunhas/.test(l.trim()));
  const body = sigStart > 0 && sigEnd > sigStart ? [...lines.slice(0, sigStart), ...lines.slice(sigEnd)] : lines;
  for (const raw of body) {
    const l = raw.trim();
    if (!l) { y -= 4; continue; }
    const h = l.match(/^(#{1,3})\s+(.*)$/);
    if (h) { y -= 6; para(plain(h[2]), bold, h[1].length === 1 ? 12.5 : 10.5); y -= 2; continue; }
    if (l.startsWith('- ')) { para(`• ${plain(l.slice(2))}`, font, 9.2, 8); continue; }
    para(plain(l), /^\*\*.*\*\*$/.test(l) ? bold : font, 9.5);
  }

  // Página de assinaturas.
  page = pdf.addPage(A4); y = A4[1] - M;
  para('PÁGINA DE ASSINATURAS', bold, 12.5); y -= 8;
  para('As Partes assinam eletronicamente este instrumento via Autentique. Os campos abaixo recebem a assinatura, o nome e a data de cada signatário.', font, 9, 0, muted);
  const z = pdf.getPageCount();
  const box = (top: number, title: string, who: string, doc: string) => {
    page.drawRectangle({ x: M, y: top - 170, width: W, height: 170, borderColor: rgb(0.85, 0.83, 0.79), borderWidth: 0.8 });
    page.drawText(safe(title), { x: M + 12, y: top - 20, size: 10.5, font: bold, color: ink });
    page.drawText(safe(who).slice(0, 95), { x: M + 12, y: top - 36, size: 9, font, color: ink });
    page.drawText(safe(doc).slice(0, 95), { x: M + 12, y: top - 50, size: 9, font, color: muted });
    page.drawLine({ start: { x: M + 12, y: top - 140 }, end: { x: M + W - 12, y: top - 140 }, thickness: 0.6, color: muted });
    page.drawText('Assinatura eletrônica', { x: M + 12, y: top - 154, size: 8, font, color: muted });
  };
  const top1 = y - 20, top2 = top1 - 200;
  box(top1, 'CONTRATANTE', parties.contractor, parties.contractorDoc);
  box(top2, 'CONTRATADA', parties.owner, 'CNPJ: 59.760.458/0001-91 · avisos@portariaprime.com.br');
  // Posição em % (origem no canto superior esquerdo, como no painel da Autentique).
  const pct = (px: number, total: number) => (Math.round((px / total) * 1000) / 10).toFixed(1);
  const at = (top: number, dx: number, dy: number) => ({ x: pct(M + dx, A4[0]), y: pct(A4[1] - (top - dy), A4[1]), z });
  const positions: Positions = {
    contractor: [{ ...at(top1, 20, 110) }, { ...at(top1, 330, 110) }],
    owner: [{ ...at(top2, 20, 110) }, { ...at(top2, 330, 110) }],
  };

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const pg = `Contrato Portaria Prime v1.0 · Página ${i + 1} de ${pages.length}`;
    p.drawText(pg, { x: A4[0] - M - font.widthOfTextAtSize(pg, 7), y: M - 24, size: 7, font, color: muted });
  });
  return { bytes: await pdf.save(), positions };
}
