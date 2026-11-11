// Capturas das telas novas a partir de /demonstracao (dados fictícios, sem rede, nada de produção).
// Uso: npm run build && vite preview --port 3017; node scripts/capture-demo-screens.mjs
// Esconde a barra da demonstração e a oferta de ajuda; gera .webp e -720.webp em public/screens.
import { chromium } from 'playwright';
import sharp from 'sharp';
const APP = process.env.APP || 'http://127.0.0.1:3017';
const SHOTS = [
  ['envios-desktop', 1440, 900, '/c/demonstracao/relatorios?tipo=envios'],
  
];
const b = await chromium.launch();
for (const [name, w, h, path] of SHOTS) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto(APP + path, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.addStyleTag({ content: `body > div:first-child > div.bg-midnight:first-child, [data-demo-bar], a[href*="ajuda?artigo"], div[aria-live="polite"].fixed { display: none !important; }` });
  await p.evaluate(() => { const bar = [...document.querySelectorAll('div')].find((d) => /^Demonstração · dados fictícios/.test(d.textContent || '') && d.getBoundingClientRect().top < 5); bar?.closest('div.bg-midnight, div[class*="midnight"]')?.remove(); window.scrollTo(0, 0); });
  await p.evaluate(() => document.fonts?.ready); await p.waitForTimeout(400);
  const png = await p.screenshot();
  await sharp(png).webp({ quality: 82 }).toFile(`public/screens/${name}.webp`);
  await sharp(png).resize(720).webp({ quality: 80 }).toFile(`public/screens/${name}-720.webp`);
  console.log('•', name);
  await p.close();
}
await b.close();
