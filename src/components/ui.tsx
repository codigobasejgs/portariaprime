import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

/* ----------------------------------------------------------------------------
 * Primitivas de interface (tokens do tema; sem cores fixas).
 * ------------------------------------------------------------------------- */

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
const btnBase =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 min-h-11 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:opacity-90',
  secondary: 'bg-surface text-text border border-line hover:bg-surface-2',
  ghost: 'text-text hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90',
  accent: 'bg-secondary text-white hover:opacity-90',
};

export function Button({
  variant = 'primary', loading, className = '', children, ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  return (
    <button {...p} disabled={p.disabled || loading} className={`${btnBase} ${btnVariants[variant]} ${className}`}>
      {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactElement<any> }) {
  const id = useRef(`f-${Math.random().toString(36).slice(2, 9)}`).current;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-text">{label}</label>
      {React.cloneElement(children, { id, 'aria-invalid': !!error, 'aria-describedby': hint || error ? `${id}-d` : undefined })}
      {(hint || error) && <p id={`${id}-d`} className={`text-xs ${error ? 'text-danger' : 'text-muted'}`}>{error || hint}</p>}
    </div>
  );
}

export const inputCls =
  'w-full min-h-11 rounded-xl border border-line bg-surface px-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...p }, ref) => <input ref={ref} {...p} className={`${inputCls} ${className}`} />,
);

export function Select({ className = '', ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={`${inputCls} ${className}`} />;
}

export function Card({ className = '', ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={`rounded-2xl border border-line bg-surface p-4 sm:p-5 ${className}`} />;
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: React.ReactNode }) {
  const styles = {
    info: 'bg-surface-2 text-text border-line',
    warning: 'bg-warning-bg text-warning border-warning/30',
    danger: 'bg-danger-bg text-danger border-danger/30',
    success: 'bg-surface-2 text-success border-success/30',
  }[tone];
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`flex gap-2 rounded-xl border p-3 text-sm ${styles}`}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent'; children: React.ReactNode }) {
  const s = {
    neutral: 'bg-surface-2 text-muted',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning-bg text-warning',
    danger: 'bg-danger-bg text-danger',
    accent: 'bg-secondary/10 text-secondary',
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${s}`}>{children}</span>;
}

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-muted text-sm">
      <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="text-center py-10 px-4">
      <p className="font-semibold text-text">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

/**
 * Pop-up. Com `footer` vira passo a passo: no celular ocupa a tela inteira, o conteúdo rola no meio e os
 * botões de ação ficam fixos embaixo (acima da barra do aparelho). `step` é o texto da etapa atual.
 */
export function Modal({ title, step, onClose, children, wide, footer }: {
  title: string; step?: string; onClose: () => void; children: React.ReactNode; wide?: boolean; footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Etapa nova começa do topo, com o foco no conteúdo (teclado e leitor de tela não ficam no botão que sumiu).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (body.current) { body.current.scrollTop = 0; body.current.focus(); }
  }, [step]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const selector = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]';
    ref.current?.querySelector<HTMLElement>(selector)?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Pop-up aberto sobre outro (conferência da leitura dentro do passo a passo): só o de cima responde.
      const open = document.querySelectorAll('[role="dialog"]');
      if (open[open.length - 1] !== ref.current) return;
      if (e.key === 'Escape') { e.preventDefault(); close.current(); }
      if (e.key !== 'Tab') return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(selector) || []).filter(el => el.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      // Passo a passo não fecha com toque fora: evita perder o que já foi preenchido.
      onMouseDown={(e) => !footer && e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={`w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} ${footer ? 'h-full sm:h-auto' : 'max-h-[92dvh] rounded-t-2xl'} sm:max-h-[92dvh] flex flex-col sm:rounded-2xl bg-surface border border-line`}>
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="font-semibold text-text">{title}{step && <span className="block text-xs font-normal text-muted" aria-live="polite">{step}</span>}</h2>
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-surface-2" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>
        <div ref={body} tabIndex={-1} className="p-4 flex-1 min-h-0 overflow-y-auto outline-none">{children}</div>
        {footer && <div className="flex flex-wrap gap-2 border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] [&>button]:flex-1">{footer}</div>}
      </div>
    </div>
  );
}

/** Opções prontas para tocar embaixo de um campo. `selected` destaca as já escolhidas. */
export function Chips({ label, options, onPick, selected = [] }: { label: string; options: string[]; onPick: (v: string) => void; selected?: string[] }) {
  if (!options.length) return null;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((o) => {
        const on = selected.includes(o);
        return <button type="button" key={o} aria-pressed={on} onClick={() => onPick(o)}
          className={`min-h-10 px-3 rounded-full border text-sm ${on ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface hover:bg-surface-2'}`}>{o}</button>;
      })}
    </div>
  );
}

/* Toasts --------------------------------------------------------------------- */
type Toast = { id: number; text: string; tone: 'success' | 'warning' | 'danger' | 'info' };
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};
export const toast = {
  success: (text: string) => pushToast({ text, tone: 'success' }),
  error: (text: string) => pushToast({ text, tone: 'danger' }),
  warn: (text: string) => pushToast({ text, tone: 'warning' }),
  info: (text: string) => pushToast({ text, tone: 'info' }),
};

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { ...t, id }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), t.tone === 'danger' ? 8000 : 5000);
    };
  }, []);
  return (
    <div aria-live="polite" className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] inset-x-4 sm:left-auto sm:right-4 sm:w-96 z-[60] space-y-2 pointer-events-none">
      {items.map((t) => (
        <div key={t.id} className="pointer-events-auto shadow-lg"><Alert tone={t.tone}>{t.text}</Alert></div>
      ))}
    </div>
  );
}

/** Wrapper para ações assíncronas com feedback. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      return r;
    } catch (e: any) {
      toast.error(e?.message || 'Algo deu errado.');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
