// vite.config.js
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { execSync } from 'child_process';

// --- Feature 1: Get Last Commit Time in NZST ---
let buildTimestamp = new Date().toISOString();
try {
  // Try to get the exact git commit time
  const gitDate = execSync('git log -1 --format=%cd').toString().trim();
  buildTimestamp = gitDate;
} catch (e) {
  console.warn("Could not retrieve git history, falling back to current time.");
}

// Format to NZST
const nzstDate = new Date(buildTimestamp).toLocaleString('en-NZ', {
  timeZone: 'Pacific/Auckland',
  dateStyle: 'full',
  timeStyle: 'long'
});
// -----------------------------------------------

export default defineConfig({
  // Inject the variable globally
  define: {
    '__BUILD_TIMESTAMP__': JSON.stringify(nzstDate),
  },

  build: {
    outDir: 'dist',
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon.png',
        'default-favicon.svg',
        'android-chrome-192x192.png',
        'android-chrome-512x512.png'
      ],
      manifest: {
        name: 'Mealmates',
        short_name: 'Mealmates',
        description: 'Order delicious food for pickup from Mealmates.',
        theme_color: '#e67e22',
        background_color: '#ffffff',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
});