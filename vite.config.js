import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Deployed as a GitHub Pages project page at /memo-web/, not the site root,
  // so all emitted asset/SW URLs must carry the /memo-web/ base prefix.
  base: '/memo-web/',
  server: {
    port: 8080,
  },
  build: {
    target: 'es2019',
    outDir: 'dist',
    emptyOutDir: true,
  },
  publicDir: 'public',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'manifest.json'],
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json,woff2}'],
        runtimeCaching: [
          {
            // GitHub API — network only (never cache API responses)
            urlPattern: /^https:\/\/api\.github\.com\/.*/i,
            handler: 'NetworkOnly',
            options: {
              backgroundSync: { name: 'github-api-queue' },
            },
          },
          {
            // index.html — network first (always get latest deployed version)
            urlPattern: /\/index\.html$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            // All other requests — stale-while-revalidate
            urlPattern: /^https?:\/\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'runtime-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
});
