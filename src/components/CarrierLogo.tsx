import { CARRIER_LIST, carrierInfo } from '../lib/carriers';

/** Selo da transportadora: glifo da marca ou sigla, na cor dela. Decorativo: o nome vem sempre em texto ao lado. */
export function CarrierLogo({ name, size = 'md' }: { name: string | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const c = carrierInfo(name);
  const box = size === 'sm' ? 'w-7 h-7 rounded-lg text-[10px]' : size === 'lg' ? 'w-12 h-12 rounded-xl text-sm' : 'w-9 h-9 rounded-lg text-xs';
  return (
    <span aria-hidden className={`${box} shrink-0 inline-flex items-center justify-center font-bold leading-none ring-1 ring-black/5 overflow-hidden`}
      style={{ background: c.bg, color: c.fg }}>
      {c.icon
        ? <svg viewBox={c.box || '0 0 24 24'} className="w-[68%] h-[68%]" fill="currentColor"><path d={c.icon} /></svg>
        : <span className="tracking-tight">{c.mono}</span>}
    </span>
  );
}

/** Escolha da transportadora por logo: frequentes no topo, todas em grade, "Outra" digitada. */
export function CarrierChoice({ value, onChange, frequent }: { value: string; onChange: (v: string) => void; frequent: string[] }) {
  const tile = (name: string, on: boolean) => (
    <button type="button" key={name} aria-pressed={on} onClick={() => onChange(name)}
      className={`flex items-center gap-2 min-h-12 rounded-xl border px-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
        ${on ? 'border-primary bg-primary/5 font-semibold ring-1 ring-primary' : 'border-line bg-surface hover:bg-surface-2'}`}>
      <CarrierLogo name={name} size="sm" /><span className="min-w-0 truncate">{name}</span>
    </button>
  );
  const known = new Set(CARRIER_LIST.map((c) => c.name));
  return (
    <div className="space-y-3">
      {frequent.length > 0 && <>
        <p className="text-xs font-medium text-muted">Frequentes</p>
        <div role="group" aria-label="Transportadoras frequentes" className="grid grid-cols-2 sm:grid-cols-3 gap-2">{frequent.map((n) => tile(n, n === value))}</div>
      </>}
      <details className="group" open={!frequent.length || (!!value && known.has(value) && !frequent.includes(value)) || undefined}>
        <summary className="cursor-pointer select-none text-sm font-medium text-primary min-h-10 flex items-center">Ver todas as transportadoras ({CARRIER_LIST.length})</summary>
        <div role="group" aria-label="Todas as transportadoras" className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-72 overflow-y-auto p-0.5">
          {CARRIER_LIST.filter((c) => !frequent.includes(c.name)).map((c) => tile(c.name, c.name === value))}
        </div>
      </details>
    </div>
  );
}
