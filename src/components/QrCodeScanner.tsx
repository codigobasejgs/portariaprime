import React, { useEffect, useRef, useState, useCallback } from 'react';
import jsQR from 'jsqr';
import { Camera, X, AlertTriangle } from 'lucide-react';
import { sound } from '../utils/audio';

interface QrCodeScannerProps {
  onDecode: (text: string) => void;
  onClose: () => void;
}

/**
 * Leitor de QR Code por câmera (jsQR) — usado na Saída da Portaria pra escanear o QR do
 * morador direto, sem precisar digitar. Roda inteiramente no navegador (nenhuma imagem
 * sai do dispositivo). Reaproveita o mesmo padrão de acesso à câmera do PackageScannerOCR.
 */
export const QrCodeScanner: React.FC<QrCodeScannerProps> = ({ onDecode, onClose }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastDecodedRef = useRef<{ text: string; at: number } | null>(null);

  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);

  const tick = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        });

        if (result?.data) {
          // Evita disparar o mesmo QR várias vezes seguidas enquanto a câmera continua ligada
          const now = Date.now();
          const last = lastDecodedRef.current;
          if (!last || last.text !== result.data || now - last.at > 3000) {
            lastDecodedRef.current = { text: result.data, at: now };
            sound.playScanBeep();
            onDecode(result.data);
          }
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [onDecode]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setHasCameraPermission(false);
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        if (cancelado) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setHasCameraPermission(true);
          rafRef.current = requestAnimationFrame(tick);
        }
      } catch (err) {
        console.warn('[QrCodeScanner] Camera Access Error', err);
        setHasCameraPermission(false);
      }
    })();

    return () => {
      cancelado = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-2xl overflow-hidden border-2 border-line bg-black relative">
      <div className="flex items-center justify-between px-3 py-2 bg-midnight text-porcelain">
        <span className="text-xs font-bold flex items-center gap-1.5">
          <Camera className="w-3.5 h-3.5 text-champagne" />
          Aponte a câmera para o QR do morador
        </span>
        <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface/10">
          <X className="w-4 h-4" />
        </button>
      </div>

      {hasCameraPermission === false ? (
        <div className="p-6 text-center space-y-2 bg-surface">
          <AlertTriangle className="w-8 h-8 text-warning mx-auto" />
          <p className="text-xs text-muted font-semibold">
            Câmera indisponível ou sem permissão. Use a retirada manual com justificativa.
          </p>
        </div>
      ) : (
        <div className="relative aspect-video">
          <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
          <canvas ref={canvasRef} className="hidden" />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-2/3 aspect-square border-2 border-champagne rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        </div>
      )}
    </div>
  );
};
