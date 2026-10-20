/**
 * Tema por condomínio: aplica cores do tenant como variáveis CSS na raiz e
 * restaura o padrão Portaria Prime ao sair/trocar de condomínio.
 */
export interface Branding {
  display_name?: string | null;
  logo_path?: string | null;
  color_primary?: string | null;
  color_secondary?: string | null;
  color_accent?: string | null;
  theme?: 'light' | 'dark' | 'system';
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Razão de contraste WCAG entre duas cores. */
export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Texto legível sobre a cor (branco ou tinta). */
export function onColor(hex: string) {
  return contrast(hex, '#FFFFFF') >= contrast(hex, '#18283A') ? '#FFFFFF' : '#18283A';
}

export function applyTheme(b: Branding | null) {
  const root = document.documentElement;
  const mode = b?.theme === 'dark' || (b?.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches && b?.theme === 'system')
    ? 'dark' : 'light';
  root.dataset.theme = b ? mode : 'light';
  for (const k of ['--c-primary', '--c-primary-fg', '--c-secondary', '--c-accent']) root.style.removeProperty(k);
  if (!b) return;
  // No escuro a primária vira cor clara de destaque; só aplicamos a do tenant no claro.
  if (mode === 'light' && b.color_primary && HEX.test(b.color_primary)) {
    root.style.setProperty('--c-primary', b.color_primary);
    root.style.setProperty('--c-primary-fg', onColor(b.color_primary));
  }
  if (b.color_secondary && HEX.test(b.color_secondary)) root.style.setProperty('--c-secondary', b.color_secondary);
  if (b.color_accent && HEX.test(b.color_accent)) root.style.setProperty('--c-accent', b.color_accent);
}

export function publicLogoUrl(path: string | null | undefined) {
  if (!path) return null;
  return `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/tenant-public/${path}`;
}
