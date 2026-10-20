import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA({
    registerType: 'prompt',
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.js',
    includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
    manifest: {
      name: 'Portaria Prime', short_name: 'Portaria Prime',
      description: 'Cada encomenda. Tudo sob controle.',
      theme_color: '#101F30', background_color: '#101F30',
      display: 'standalone', start_url: '/', scope: '/', lang: 'pt-BR',
      icons: [
        { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    injectManifest: { globPatterns: ['**/*.{js,css,html,png,ico,webmanifest}'] },
  })],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  build: { sourcemap: false },
  server: {
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
});
