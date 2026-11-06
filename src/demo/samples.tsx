import React from 'react';
import { DEMO } from './mode';
import { store } from './store';
import { WAITING } from './rpc';

/** Botões "usar exemplo" (sem câmera) para OCR, QR e foto. Só aparecem em /demonstracao. */
const btn = 'min-h-11 rounded-xl border border-dashed border-line px-4 text-sm font-medium text-muted hover:text-text';

function draw(lines: string[], bg: string): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 400;
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#111'; g.font = 'bold 28px sans-serif';
  lines.forEach((l, i) => g.fillText(l, 32, 60 + i * 52));
  g.font = 'bold 22px sans-serif'; g.fillStyle = '#b91c1c'; g.fillText('DEMONSTRAÇÃO · DADOS FICTÍCIOS', 32, 370);
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('Falha ao gerar imagem.'))), 'image/jpeg', 0.85));
}

export function DemoLabelSample({ onPick }: { onPick: (b: Blob) => void }) {
  if (!DEMO) return null;
  return <button type="button" className={btn} onClick={async () => onPick(await draw(['Correios · DM5550001BR', 'Para: João Silva', 'Bloco A · Apto 101', 'Rem.: Loja Exemplo'], '#fff8e7'))}>
    Usar etiqueta de exemplo</button>;
}

export function DemoPhotoSample({ onPick }: { onPick: (b: Blob) => void }) {
  if (!DEMO) return null;
  return <button type="button" className={btn} onClick={async () => onPick(await draw(['Foto de exemplo', 'Item entregue na portaria'], '#e8eef7'))}>Usar foto de exemplo</button>;
}

/** Emite um QR de verdade (mesmo fluxo do morador) para a encomenda aguardando mais antiga. */
export function DemoQrSample({ onPick }: { onPick: (code: string) => void }) {
  if (!DEMO) return null;
  const pick = () => {
    const p = store.s.packages.filter((x) => WAITING.includes(x.status)).sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
    if (!p) return alert('Nenhuma encomenda aguardando retirada.');
    const token = `PPDEMO.${crypto.randomUUID()}`;
    store.s.tokens.push({ token, package_id: p.id, expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(), used_at: null });
    store.save();
    onPick(token);
  };
  return <button type="button" className={btn} onClick={pick}>Usar QR de exemplo</button>;
}
