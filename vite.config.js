// vite.config.js

import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
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
      // Ensure all your icon assets are included for caching
      includeAssets: [
          'favicon.ico',
          'apple-touch-icon.png',
          'default-favicon.svg',
          'android-chrome-192x192.png', // Added
          'android-chrome-512x512.png'  // Added
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
            // Updated to the standard generator filename
            src: 'android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            // Updated to the standard generator filename
            src: 'android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
});