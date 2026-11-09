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
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

// O canvas de detecção é exatamente o recorte visível (object-cover 3:4), então o oval desenhado e a checagem
// usam as mesmas frações. Mudou o oval? Muda só aqui.
const W = 480, H = 640;
const OVAL = { cx: 0.5, cy: 0.45, rx: 0.32, ry: 0.33 };
const OVAL_PATH = `M${OVAL.cx * 100} ${(OVAL.cy - OVAL.ry) * 100}a${OVAL.rx * 100} ${OVAL.ry * 100} 0 1 1 0 ${OVAL.ry * 200}a${OVAL.rx * 100} ${OVAL.ry * 100} 0 1 1 0 ${-OVAL.ry * 200}`;
const COLOR = { search: '#ffffff', adjust: '#f59e0b', ok: '#22c55e' };
type Tone = keyof typeof COLOR;

/** Dica de posicionamento; vazio = rosto dentro do oval. A prévia é espelhada, então "esquerda" é a do próprio usuário. */
function align(b: { x: number; y: number; width: number; height: number }) {
  const cx = (b.x + b.width / 2) / W, cy = (b.y + b.height / 2) / H, size = b.width / W;
  if (size < 0.3) return 'Aproxime o rosto da câmera.';
  if (size > 0.75) return 'Afaste um pouco o rosto da câmera.';
  if (Math.abs(cx - OVAL.cx) > 0.12) return `Mova o rosto um pouco para a ${cx < OVAL.cx ? 'esquerda' : 'direita'}.`;
  if (Math.abs(cy - OVAL.cy) > 0.1) return `Mova o rosto um pouco para ${cy < OVAL.cy ? 'baixo' : 'cima'}.`;
  return '';
}

/** Luz e nitidez (luma) no miolo do rosto, sem o fundo. */
function quality(ctx: CanvasRenderingContext2D, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(0, Math.round(b.x + b.width * 0.2)), y = Math.max(0, Math.round(b.y + b.height * 0.2));
  const w = Math.max(2, Math.min(W - x, Math.round(b.width * 0.6))), h = Math.max(1, Math.min(H - y, Math.round(b.height * 0.6)));
  const d = ctx.getImageData(x, y, w, h).data;
  let light = 0, sharp = 0, prev = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (i % (w * 4)) sharp += Math.abs(l - prev);
    light += l; prev = l;
  }
  return { light: light / (w * h), sharp: sharp / (w * h) };
}

/** Active client challenge deters static paper/photos; NOT server-attested PAD.
 * Browser code/embeddings can be forged. Password is mandatory even after success.
 */
export function PorterFaceCapture({ onCapture, enrollment = false }: { onCapture: (v: FaceCapture) => void; enrollment?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [tone, setTone] = useState<Tone>('search');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('Abrindo a câmera…');
  const [error, setError] = useState('');
  const start = async () => {
    const run = ++generation.current;
    const current = () => alive.current && run === generation.current;
    const show = (t: Tone, m: string) => { setTone(t); setMessage(m); };
    let own: MediaStream | null = null;
    setBusy(true); setError(''); setProgress(0); show('search', 'Carregando reconhecimento facial…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Câmera indisponível. Use HTTPS ou solicite acesso alternativo ao síndico.');
      const f = await models();
      if (!current()) return;
      own = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!current()) return;
      stream.current = own;
      const v = video.current!; v.srcObject = own; await v.play();
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const opts = new f.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
      const challenge = crypto.getRandomValues(new Uint8Array(1))[0] % 2 ? 'blink' : 'turn';
      const direction = crypto.getRandomValues(new Uint8Array(1))[0] % 2 ? 1 : -1;
      const need = enrollment ? 5 : 3;
      let stage = 0, frontal = 0, base = 0, closed = false;
      const samples: number[][] = [];
      const end = Date.now() + 90000;
      show('search', 'Posicione o rosto dentro do oval.');
      while (Date.now() < end) {
        await nextFrame();
        if (!current()) return;
        const vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) continue;
        const s = Math.min(vw / W, vh / H); // mesmo recorte central do object-cover
        ctx.drawImage(v, (vw - W * s) / 2, (vh - H * s) / 2, W * s, H * s, 0, 0, W, H);
        const q = f.detectAllFaces(canvas, opts).withFaceLandmarks();
        const faces = stage === 2 ? await q.withFaceDescriptors() : await q;
        if (!current()) return;
        if (faces.length !== 1) { show('search', faces.length ? 'Somente uma pessoa na câmera.' : 'Procurando rosto… posicione-o dentro do oval.'); samples.length = 0; continue; }
        const face = faces[0], box = face.detection.box, p = face.landmarks.positions;
        const hint = align(box);
        if (hint) { show('adjust', hint); samples.length = 0; if (stage === 0) { frontal = 0; base = 0; } continue; }
        const left = p[36], right = p[45], nose = p[30];
        const yaw = (nose.x - (left.x + right.x) / 2) / distance(left, right);
        const eye = (ear(p.slice(36, 42)) + ear(p.slice(42, 48))) / 2;
        if (stage === 0) {
          if (Math.abs(yaw) > 0.15) { show('adjust', 'Olhe de frente para a câmera.'); frontal = 0; base = 0; continue; }
          show('ok', 'Ótimo, fique assim…'); base += eye;
          if (++frontal >= 3) { base /= frontal; stage = 1; }
          setProgress(frontal * 8);
        } else if (stage === 1) {
          // Piscada relativa aos olhos abertos da própria pessoa: limiar fixo falhava em olhos menores.
          if (challenge === 'blink') {
            show('ok', 'Agora pisque os olhos devagar.');
            if (eye < base * 0.72) closed = true;
            if (closed && eye > base * 0.88) stage = 2;
          } else {
            show('ok', `Agora vire devagar o rosto para ${direction === 1 ? 'sua esquerda' : 'sua direita'}.`);
            if (yaw * direction > 0.18) stage = 2;
          }
          if (stage === 2) setProgress(40);
        } else {
          if (Math.abs(yaw) > 0.15 || eye < base * 0.75) { show('adjust', 'Volte ao centro e olhe para a câmera.'); samples.length = 0; continue; }
          const { light, sharp } = quality(ctx, box);
          if (light < 40) { show('adjust', 'Pouca luz no rosto: fique de frente para uma janela ou lâmpada.'); samples.length = 0; continue; }
          if (light > 220) { show('adjust', 'Luz forte demais no rosto: afaste-se da lâmpada.'); samples.length = 0; continue; }
          if (sharp < 1.5) { show('adjust', 'Imagem tremida: segure o celular firme.'); samples.length = 0; continue; }
          const descriptor = Array.from(face.descriptor) as number[];
          if (samples.length && Math.hypot(...descriptor.map((x, i) => x - samples[0][i])) > 0.35) { samples.length = 0; continue; }
          samples.push(descriptor);
          show('ok', 'Fique parado…'); setProgress(40 + 60 * samples.length / need);
          if (samples.length >= need) {
            const average = descriptor.map((_, i) => samples.reduce((sum, a) => sum + a[i], 0) / samples.length);
            onCapture({ descriptor: average, photo: canvas.toDataURL('image/jpeg', 0.85), liveness: true });
            setDone(true); show('ok', 'Rosto capturado.'); return;
          }
        }
      }
      throw new Error('Não deu para concluir em 90 segundos. Fique em local iluminado, rosto inteiro no oval, e tente de novo.');
    } catch (e) { if (current()) setError((e as Error).message); }
    finally {
      own?.getTracks().forEach(t => t.stop());
      if (stream.current === own) stream.current = null;
      if (current()) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    if (!DEMO) void start();
    return () => { alive.current = false; generation.current++; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  }, []);
  if (DEMO) return <div className="space-y-2"><Alert>Simulação local: nenhum rosto real, câmera ou dado biométrico é utilizado.</Alert><Button onClick={() => { onCapture({ descriptor: Array(128).fill(0.1), photo: '', liveness: true }); setMessage('Rosto de exemplo simulado.'); }}>Simular rosto do porteiro de exemplo</Button><p role="status">{message}</p></div>;
  return <div className="space-y-3">
    <div className="relative mx-auto w-full max-w-xs aspect-[3/4] overflow-hidden rounded-2xl bg-black">
      <video ref={video} autoPlay muted playsInline aria-label="Câmera para captura facial" className="absolute inset-0 w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />
      <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
        <path d={`M0 0H100V100H0Z${OVAL_PATH}`} fillRule="evenodd" fill="rgba(0,0,0,0.55)" />
        <path d={OVAL_PATH} fill="none" stroke={COLOR[tone]} strokeWidth={3} vectorEffect="non-scaling-stroke" />
        {progress > 0 && <path d={OVAL_PATH} fill="none" stroke={COLOR.ok} strokeWidth={2} strokeLinecap="round" pathLength={100} strokeDasharray={`${progress} 100`} />}
      </svg>
      <p role="status" aria-live="polite" className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-2 text-center text-sm font-medium text-white">{message}</p>
    </div>
    {error && <Alert tone="danger">{error}</Alert>}
    {!busy && !done && <Button type="button" onClick={start}>Tentar novamente</Button>}
    <p className="text-xs text-muted">Câmera comum não comprova presença contra vídeos, máscaras ou navegador adulterado. Senha continua obrigatória. Não é identificação facial certificada.</p>
  </div>;
}
