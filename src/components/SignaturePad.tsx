import React, { useRef, useState, useEffect, useCallback } from 'react';
import { RotateCcw, Check, PenTool } from 'lucide-react';
import { sound } from '../utils/audio';

interface SignaturePadProps {
  onSignatureChange: (dataUrl: string | null) => void;
  height?: number;
  width?: number;
  penColor?: string;
  strokeWidth?: number;
}

export const SignaturePad: React.FC<SignaturePadProps> = ({
  onSignatureChange,
  height = 180,
  width,
  penColor = '#18283A',
  strokeWidth = 2.5
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  // Setup canvas size accounting for devicePixelRatio
  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = width || rect.width || 320;
    const displayHeight = height;

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = penColor;
      ctx.lineWidth = strokeWidth;
    }
  }, [height, width, penColor, strokeWidth]);

  useEffect(() => {
    setupCanvas();

    const handleResize = () => {
      // Re-setup on window resize
      setupCanvas();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [setupCanvas]);

  const getCanvasCoordinates = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ('touches' in e) {
      if (e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      }
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  };

  const startDrawing = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const coords = getCanvasCoordinates(e);
    lastPointRef.current = coords;
    setIsDrawing(true);

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(coords.x, coords.y);
      ctx.lineTo(coords.x + 0.1, coords.y + 0.1);
      ctx.stroke();
    }
  };

  const draw = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    if (!isDrawing || !lastPointRef.current) return;
    e.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) return;

    const coords = getCanvasCoordinates(e);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
      ctx.lineTo(coords.x, coords.y);
      ctx.stroke();
    }

    lastPointRef.current = coords;
    if (!hasSignature) {
      setHasSignature(true);
    }
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    lastPointRef.current = null;

    const canvas = canvasRef.current;
    if (canvas && hasSignature) {
      const dataUrl = canvas.toDataURL('image/png');
      onSignatureChange(dataUrl);
    }
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    }

    setHasSignature(false);
    onSignatureChange(null);
    sound.playScanBeep();
  };

  return (
    <div ref={containerRef} className="w-full space-y-2">
      <div className="relative rounded-2xl bg-white border-2 border-dashed border-line overflow-hidden shadow-inner touch-none">
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="cursor-crosshair w-full block bg-white"
        />

        {/* Signature guideline line */}
        <div className="absolute bottom-6 left-6 right-6 border-b border-slate-300 pointer-events-none flex items-center justify-between text-[10px] text-slate-400">
          <span className="flex items-center gap-1 font-medium pb-1">
            <PenTool className="w-3 h-3 text-muted" />
            Assine acima com o dedo ou caneta touch
          </span>
          <span className="font-mono text-[9px] pb-1">X</span>
        </div>

        {/* Badge when signed */}
        {hasSignature && (
          <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-surface-2 text-success border border-line text-[10px] font-black flex items-center gap-1 shadow-xs pointer-events-none animate-in fade-in">
            <Check className="w-3 h-3 text-success" />
            <span>Assinatura Capturada</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-[11px] text-muted font-medium">
          Validade jurídica nos termos do Art. 10 da MP 2.200-2/2001
        </span>
        <button
          type="button"
          onClick={handleClear}
          disabled={!hasSignature}
          className="px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-line text-text font-bold text-[11px] flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Limpar / Refazer</span>
        </button>
      </div>
    </div>
  );
};
