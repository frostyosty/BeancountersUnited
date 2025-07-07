import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
   build: {
     outDir: 'dist', // **Crucial: Set output directory to 'dist'**
   },
   plugins: [
     VitePWA({
       registerType: 'autoUpdate',
       injectRegister: 'auto',
       includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'default-favicon.svg'], // Add your assets
       manifest: {
         // **Update these for your restaurant**
         name: 'My Awesome Restaurant',
         short_name: 'RestaurantApp',
         description: 'Order delicious food for pickup.',
         theme_color: '#e67e22', // Your brand's accent color
         background_color: '#ecf0f1', // Your brand's background color
         start_url: '/',
         display: 'standalone',
         orientation: 'portrait',
         icons: [
           {
             src: 'pwa-192x192.png', // You'll need to create these icons
             sizes: '192x192',
             type: 'image/png',
           },
           {
             src: 'pwa-512x512.png', // You'll need to create these icons
             sizes: '512x512',
             type: 'image/png',
             purpose: 'any maskable',
           },
         ],
       },
     }),
   ],
 });
