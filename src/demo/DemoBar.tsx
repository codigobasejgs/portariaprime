import React from 'react';
import { ADDRESS_PRESETS } from '../pages/tenant/config/AddressingCard';
import { profile, setProfile, type DemoProfile } from './mode';
import { store } from './store';

const PROFILES: [DemoProfile, string][] = [['admin', 'Síndico'], ['porteiro', 'Portaria'], ['morador', 'Morador'], ['totem', 'Totem']];
const sel = 'min-h-9 min-w-0 max-w-full rounded-lg border border-champagne/40 bg-midnight px-2 text-sm text-white';

/** Faixa fixa da demonstração: perfil, tipologia, restaurar e contratar. */
export function DemoBar() {
  const s = store.s.settings;
  const typology = (v: string) => {
    const p = ADDRESS_PRESETS.find(([k]) => k === v);
    if (!p) return;
    Object.assign(s, { condo_type: p[0], unit_group_label: p[2], unit_number_label: p[3] });
    store.save();
    location.reload();
  };
  return (
    <div role="region" aria-label="Demonstração" className="sticky top-0 z-50 w-full bg-midnight text-champagne border-b border-champagne/30">
      <div className="mx-auto max-w-7xl flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm">
        <strong className="min-w-0 font-semibold">Demonstração · dados fictícios</strong>
        <label className="flex min-w-0 items-center gap-1">
          <span className="sr-only sm:not-sr-only">Perfil</span>
          <select aria-label="Perfil" className={sel} value={profile()} onChange={(e) => setProfile(e.target.value as DemoProfile)}>
            {PROFILES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-1">
          <span className="sr-only sm:not-sr-only">Tipologia</span>
          <select aria-label="Tipologia" className={sel} value={s.condo_type} onChange={(e) => typology(e.target.value)}>
            {ADDRESS_PRESETS.filter(([k]) => k !== 'personalizado').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
          <a href="/c/demonstracao/configuracoes?perfil=admin&m=assistente" className="min-h-9 inline-flex items-center rounded-lg border border-champagne/50 px-3 hover:bg-white/10">Testar IA no WhatsApp</a>
          <button type="button" onClick={() => confirm('Restaurar os dados de exemplo? As alterações desta demonstração serão perdidas.') && store.reset()}
            className="min-h-9 rounded-lg border border-champagne/50 px-3 hover:bg-white/10">Restaurar</button>
          <a href="/planos" className="min-h-9 inline-flex items-center rounded-lg bg-champagne px-3 font-semibold text-midnight hover:opacity-90">Contratar</a>
        </div>
      </div>
    </div>
  );
}
