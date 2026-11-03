// PDF do painel com pdf-lib e Helvetica padrão (codificação WinAnsi: cobre ç, ã, é, º etc.).
// Caracteres fora do WinAnsi (→, ≤, emoji) são trocados por equivalentes antes de desenhar.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { Cell } from './xlsx';

const SUBST: Record<string, string> = { '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '—': '-', ' ': ' ', ' ': ' ' };
export function winAnsi(s: string, font: PDFFont) {
  const ok = new Set(font.getCharacterSet());
  return Array.from(s.normalize('NFC')).map((c) => SUBST[c] ?? (ok.has(c.codePointAt(0)!) ? c : '?')).join('');
}

export async function dashboardPdf(title: string, subtitle: string[], tables: { name: string; rows: Cell[][] }[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(winAnsi(title, font)); doc.setProducer('Portaria Prime');
  const W = 595, H = 842, M = 40;
  let page = doc.addPage([W, H]), y = H - M;
  const line = (text: string, size = 9, f = font, x = M) => { page.drawText(winAnsi(text, f), { x, y, size, font: f, color: rgb(0.1, 0.12, 0.19) }); };
  const need = (h: number) => { if (y - h < M) { page = doc.addPage([W, H]); y = H - M; } };
  line(title, 16, bold); y -= 20;
  for (const s of subtitle) { line(s, 9); y -= 13; }
  for (const t of tables) {
    y -= 10; need(30); line(t.name, 12, bold); y -= 16;
    const cols = Math.max(...t.rows.map((r) => r.length));
    const colW = (W - 2 * M) / cols;
    t.rows.forEach((r, i) => {
      need(13);
      const head = t.name === 'Indicadores' ? r[0] === 'Indicador' : i === 0;
      r.forEach((v, ci) => {
        const f = head ? bold : font;
        let s = winAnsi(v == null ? '' : typeof v === 'number' ? v.toLocaleString('pt-BR') : String(v), f);
        while (s.length > 1 && f.widthOfTextAtSize(s, 8) > colW - 4) s = s.slice(0, -1); // corta o que não cabe na coluna
        page.drawText(s, { x: M + ci * colW, y, size: 8, font: f, color: rgb(0.1, 0.12, 0.19) });
      });
      y -= 12;
    });
  }
  return doc.save();
}
