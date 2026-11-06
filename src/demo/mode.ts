/** Evaluated before any client/session is constructed. Never inferred from saved auth. */
export const DEMO = typeof location !== 'undefined' && /^\/(?:demonstracao\/?$|c\/demonstracao(?:\/|$))/.test(location.pathname);
export const TENANT = '00000000-0000-4000-8000-000000000001';
export type DemoProfile = 'admin' | 'porteiro' | 'morador' | 'totem';
let chosen: DemoProfile | null = null;
/** ?perfil= wins and sticks (memory + sessionStorage), so in-app navigation without the query keeps the same profile. */
export function profile(): DemoProfile {
  const q = new URLSearchParams(location.search).get('perfil');
  if (q && ['admin', 'porteiro', 'morador', 'totem'].includes(q)) {
    chosen = q as DemoProfile;
    try { sessionStorage.setItem('pp-demo-profile', q); } catch { /* memory only */ }
  }
  if (chosen) return chosen;
  try { return (chosen = (sessionStorage.getItem('pp-demo-profile') as DemoProfile) || 'admin'); } catch { return (chosen = 'admin'); }
}
export function profilePath(p: DemoProfile) { return `/c/demonstracao/${p === 'admin' ? 'painel' : p === 'morador' ? 'inicio' : p === 'totem' ? 'totem-equipe' : 'portaria'}?perfil=${p}`; }
export function setProfile(p: DemoProfile) { try { sessionStorage.setItem('pp-demo-profile', p); } catch { /* memory-only browser */ } location.assign(profilePath(p)); }
