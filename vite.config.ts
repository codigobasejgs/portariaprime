import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { legacyCssPlugin } from './scripts/legacy-css.mjs';

export default defineConfig({
  plugins: [react(), tailwindcss(), legacyCssPlugin(), VitePWA({
    registerType: 'prompt',
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.js',
    includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
    manifest: {
      name: 'Portaria Prime', short_name: 'Portaria Prime',
      description: 'Cada encomenda. Tudo sob controle.',
      theme_color: '#101F30', background_color: '#101F30',
      id: '/', display: 'standalone', start_url: '/app', scope: '/', lang: 'pt-BR', orientation: 'any',
      icons: [
        { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    // Capturas da landing ficam fora do precache (peso); o navegador as cacheia por HTTP.
    injectManifest: { globPatterns: ['**/*.{js,css,html,png,ico,webmanifest}'], globIgnores: ['screens/**', 'models/**'] },
  })],
  // NEXT_PUBLIC_* = nomes criados pela integração Supabase da Vercel (somente chaves públicas).
  envPrefix: ['VITE_', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  // Android 8+ (Chrome 64): sintaxe JS rebaixada pelo esbuild; CSS em scripts/legacy-css.mjs.
  build: { target: ['chrome64', 'safari12', 'firefox60', 'edge79'], cssTarget: ['chrome64', 'safari12'], sourcemap: false, rollupOptions: { output: { manualChunks: { supabase: ['@supabase/supabase-js'], react: ['react', 'react-dom'] } } } },
  server: {
    // Somente desenvolvimento: iniciar scripts/dev-api.mjs separadamente.
    // /api/_lib/* é código-fonte importado pelo front (demonstração): quem serve é o Vite, não a API.
    proxy: { '/api': { target: 'http://127.0.0.1:3019', bypass: (req) => (req.url?.startsWith('/api/_lib/') ? req.url : undefined) } },
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
});
