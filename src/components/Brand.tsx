/**
 * Logos oficiais Portaria Prime (PNGs do kit em public/brand, sem redesenho).
 * "claro" = texto escuro, para fundo claro; "escuro" = texto claro, para fundo escuro.
 */
export function PortariaPrimeLogo({ onDark = false, className = 'h-9 w-auto' }: { onDark?: boolean; className?: string }) {
  return (
    <img
      src={onDark ? '/brand/logo-horizontal-escuro.png' : '/brand/logo-horizontal-claro.png'}
      alt="Portaria Prime"
      width={600}
      height={185}
      className={className}
    />
  );
}

export function PortariaPrimeSymbol({ className = 'h-8 w-8' }: { className?: string }) {
  return <img src="/brand/simbolo.png" alt="" aria-hidden width={256} height={256} className={className} />;
}

export const TAGLINE = 'Cada encomenda. Tudo sob controle.';
export const SIGNATURE = 'Gestão de encomendas para uma portaria mais organizada';
