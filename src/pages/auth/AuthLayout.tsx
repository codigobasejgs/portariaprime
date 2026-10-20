import React from 'react';
import { PortariaPrimeLogo, TAGLINE } from '../../components/Brand';
import { onLink } from '../../lib/router';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh grid lg:grid-cols-2">
      <aside className="hidden lg:flex flex-col justify-between bg-midnight text-porcelain p-12">
        <a href="/" onClick={onLink}><PortariaPrimeLogo onDark className="h-12 w-auto" /></a>
        <div>
          <p className="text-3xl font-semibold leading-tight max-w-md">{TAGLINE}</p>
          <p className="mt-3 text-porcelain/70 max-w-md">Recebimento, guarda, aviso e retirada de encomendas com rastreabilidade para cada condomínio.</p>
        </div>
        <p className="text-xs text-porcelain/50">© Portaria Prime</p>
      </aside>
      <main className="flex flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <a href="/" onClick={onLink} className="lg:hidden inline-block mb-8"><PortariaPrimeLogo className="h-10 w-auto" /></a>
          <h1 className="text-2xl font-semibold text-text">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
