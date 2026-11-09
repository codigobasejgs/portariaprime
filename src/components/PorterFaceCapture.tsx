import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button } from './ui';
import { DEMO } from '../demo/mode';

export type FaceCapture = { descriptor: number[]; photo: string; liveness: boolean };
const MODEL = '/models/face-api-1.7.15';
let loaded: Promise<any> | null = null;
async function models() {
  if (!loaded) loaded = import(/* @vite-ignore */ `${MODEL}/face-api.esm.js`).then(async (f) => {
    await Promise.all([f.nets.tinyFaceDetector.loadFromUri(MODEL), f.nets.faceLandmark68Net.loadFromUri(MODEL), f.nets.faceRecognitionNet.loadFromUri(MODEL)]);
    return f;
  }).catch(e => { loaded = null; throw e; });
  return loaded;
}
const distance = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
const ear = (p: any[]) => (distance(p[1], p[5]) + distance(p[2], p[4])) / (2 * distance(p[0], p[3]));

/** Active client challenge deters static paper/photos; NOT server-attested PAD.
 * Browser code/embeddings can be forged. Password is mandatory even after success.
 */
export function PorterFaceCapture({ onCapture, enrollment = false }: { onCapture: (v: FaceCapture) => void; enrollment?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Use boa iluminação, sem óculos escuros. Posicione somente seu rosto no oval.');
  const [error, setError] = useState('');
  const stop = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; stop(); }; }, []);
  const start = async () => {
    const run = ++generation.current;
    const current = () => alive.current && run === generation.current;
    setBusy(true); setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Câmera indisponível. Use HTTPS ou solicite acesso alternativo ao síndico.');
      setMessage('Carregando modelos locais de reconhecimento…');
      const f = await models();
      if (!current()) return;
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (!current()) { camera.getTracks().forEach(t => t.stop()); return; }
      stream.current = camera;
      const v = video.current!; v.srcObject = camera; await v.play();
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const challenge = crypto.getRandomValues(new Uint8Array(1))[0] % 2 ? 'blink' : 'turn';
      const direction = crypto.getRandomValues(new Uint8Array(1))[0] % 2 ? 1 : -1;
      let stage = 0, open = false, closed = false, frontal = 0;
      const samples: number[][] = [];
      const end = Date.now() + 60000;
      while (current() && Date.now() < end) {
        ctx.drawImage(v, 0, 0, 640, 480);
        const faces = await f.detectAllFaces(canvas, new f.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.65 })).withFaceLandmarks().withFaceDescriptors();
        if (!current()) return;
        if (faces.length !== 1) { setMessage(faces.length ? 'Somente uma pessoa na câmera.' : 'Posicione o rosto no oval.'); samples.length = 0; continue; }
        const face = faces[0], box = face.detection.box, p = face.landmarks.positions;
        if (box.width < 160 || box.width > 390 || Math.abs(box.x + box.width / 2 - 320) > 100 || Math.abs(box.y + box.height / 2 - 240) > 95) { setMessage('Centralize o rosto e aproxime-se do oval.'); samples.length = 0; continue; }
        const pixels = ctx.getImageData(Math.max(0, Math.round(box.x)), Math.max(0, Math.round(box.y)), Math.min(100, Math.round(box.width)), Math.min(100, Math.round(box.height))).data;
        let light = 0, sharp = 0;
        for (let i = 4; i < pixels.length; i += 4) { light += pixels[i]; sharp += Math.abs(pixels[i] - pixels[i - 4]); }
        if (light / (pixels.length / 4) < 45 || light / (pixels.length / 4) > 225 || sharp / (pixels.length / 4) < 3) { setMessage('Melhore a iluminação e mantenha a câmera firme (imagem desfocada).'); samples.length = 0; continue; }
        const left = p[36], right = p[45], nose = p[30];
        const yaw = (nose.x - (left.x + right.x) / 2) / distance(left, right);
        const eye = (ear(p.slice(36, 42)) + ear(p.slice(42, 48))) / 2;
        if (stage === 0) {
          setMessage('Olhe de frente para a câmera, olhos abertos.');
          if (Math.abs(yaw) < 0.12 && eye > 0.23 && ++frontal >= 3) stage = 1;
        } else if (stage === 1) {
          if (challenge === 'blink') {
            setMessage('Desafio: pisque os dois olhos e abra novamente.');
            if (eye > 0.23) open = true;
            if (open && eye < 0.19) closed = true;
            if (closed && eye > 0.23) stage = 2;
          } else {
            setMessage(`Desafio: vire devagar o rosto para ${direction === 1 ? 'sua esquerda' : 'sua direita'}, depois volte ao centro.`);
            if (yaw * direction > 0.20) stage = 2;
          }
        } else {
          setMessage('Volte ao centro. Olhe para a câmera e mantenha-se parado.');
          if (Math.abs(yaw) > 0.12 || eye < 0.21) { samples.length = 0; continue; }
          const descriptor = Array.from(face.descriptor) as number[];
          if (samples.length && Math.hypot(...descriptor.map((x, i) => x - samples[0][i])) > 0.30) { samples.length = 0; continue; }
          samples.push(descriptor);
          if (samples.length >= (enrollment ? 5 : 3)) {
            const average = descriptor.map((_, i) => samples.reduce((s, a) => s + a[i], 0) / samples.length);
            onCapture({ descriptor: average, photo: canvas.toDataURL('image/jpeg', 0.82), liveness: true });
            setMessage('Captura concluída. A comparação será feita no servidor.'); return;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (current()) throw new Error('Captura não concluída em 60 segundos. Melhore a iluminação e tente novamente.');
    } catch (e) { if (current()) setError((e as Error).message); }
    finally { stop(); if (current()) setBusy(false); }
  };
  if (DEMO) return <div className="space-y-2"><Alert>Simulação local: nenhum rosto real, câmera ou dado biométrico é utilizado.</Alert><Button onClick={() => { onCapture({ descriptor: Array(128).fill(0.1), photo: '', liveness: true }); setMessage('Rosto de exemplo simulado.'); }}>Simular rosto do porteiro de exemplo</Button><p role="status">{message}</p></div>;
  return <div className="space-y-3">
    <div className="relative mx-auto max-w-sm aspect-[4/3] overflow-hidden rounded-xl bg-black">
      <video ref={video} autoPlay muted playsInline aria-label="Câmera para captura facial" className="w-full h-full object-cover" />
      <div aria-hidden className="absolute inset-y-[12%] inset-x-[23%] border-2 border-white rounded-[50%] pointer-events-none" />
    </div>
    <p role="status" className="text-sm">{message}</p>{error && <Alert tone="danger">{error}</Alert>}
    <Button type="button" loading={busy} onClick={start}>Capturar rosto com desafio</Button>
    {busy && <Button type="button" variant="ghost" onClick={() => { generation.current++; stop(); setBusy(false); }}>Cancelar captura</Button>}
    <p className="text-xs text-muted">Câmera comum não comprova presença contra vídeos, máscaras ou navegador adulterado. Senha continua obrigatória. Não é identificação facial certificada.</p>
  </div>;
}
