import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { execSync } from 'child_process';

// --- 1. Calculate NZST Timestamp ---
let buildTimestamp = new Date().toISOString();
try {
  // Get the last commit date from git
  const gitDate = execSync('git log -1 --format=%cd').toString().trim();
  buildTimestamp = gitDate;
} catch (e) {
  console.warn("Git history not found, using current time.");
}

// Format for New Zealand
const nzstDate = new Date(buildTimestamp).toLocaleString('en-NZ', {
  timeZone: 'Pacific/Auckland',
  dateStyle: 'full',
  timeStyle: 'long'
});
// -----------------------------------

export default defineConfig({
  // --- 2. Inject Global Variable ---
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
        name: 'BeancountersUnited',
        short_name: 'BeancountersUnited',
        description: 'Order delicious food for pickup from BeancountersUnited.',
        theme_color: '#e67e22',
        background_color: '#ffffff',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});