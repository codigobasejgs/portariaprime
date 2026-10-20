import React, { useEffect, useRef, useState } from 'react';
import { Camera, Upload } from 'lucide-react';
import { Alert, Button } from './ui';

/**
 * Captura de foto pela câmera, com alternativa de arquivo quando a permissão
 * é negada ou não há câmera. Devolve Blob JPEG (re-encodado no chamador).
 */
export function CameraCapture({ onCapture, label = 'Fotografar' }: { onCapture: (b: Blob) => void; label?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'on' | 'denied'>('idle');
  const stream = useRef<MediaStream | null>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stop, []);

  const start = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('sem câmera');
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false });
      setState('on');
      requestAnimationFrame(() => {
        if (video.current) {
          video.current.srcObject = stream.current;
          video.current.play();
        }
      });
    } catch {
      setState('denied');
    }
  };

  const shoot = () => {
    const v = video.current;
    if (!v) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) { stop(); setState('idle'); onCapture(b); } }, 'image/jpeg', 0.9);
  };

  return (
    <div className="space-y-2">
      {state === 'on' ? (
        <div className="space-y-2">
          <video ref={video} playsInline muted className="w-full rounded-xl bg-black aspect-video object-cover" />
          <div className="flex gap-2">
            <Button type="button" onClick={shoot} className="flex-1"><Camera className="w-4 h-4" /> Capturar</Button>
            <Button type="button" variant="secondary" onClick={() => { stop(); setState('idle'); }}>Cancelar</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={start}><Camera className="w-4 h-4" /> {label}</Button>
          <Button type="button" variant="ghost" onClick={() => file.current?.click()}><Upload className="w-4 h-4" /> Enviar arquivo</Button>
        </div>
      )}
      {state === 'denied' && <Alert tone="warning">Câmera indisponível ou sem permissão. Envie um arquivo ou siga sem foto.</Alert>}
      <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onCapture(f); e.target.value = ''; }} />
    </div>
  );
}
