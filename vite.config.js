// vite.config.js
import { defineConfig } from 'vite';
import legacy from '@vitejs/plugin-legacy'; // For broader browser support with vanilla JS

export default defineConfig({
  plugins: [
    legacy({
      targets: ['defaults', 'not IE 11'], // Or your desired browser support
    }),
  ],
  // We will build into the 'public' folder directly for now
  // to minimize changes to your Vercel setup.
  // Vite's default is 'dist', but we can override.
  build: {
    outDir: 'public', // Vite will build its output into your existing 'public' folder
    emptyOutDir: false, // IMPORTANT: Set to false initially if 'public' has other essential files
                       // that Vite doesn't manage (like your API folder if it was in public).
                       // HOWEVER, best practice is to let Vite control 'public' completely.
                       // For a cleaner setup later, you'd make Vite output to 'dist' and
                       // adjust vercel.json. Let's start with this simpler way.
    manifest: true, // Generates a manifest.json, useful for Vercel
    rollupOptions: {
      // If you have multiple HTML entry points, specify them here
      // For a single page app (SPA), usually just index.html at root.
      input: {
        main: 'index.html' // Assumes index.html is at project root
      }
    }
  },
  // If your index.html is NOT at root but in, say, /src, then:
  // root: 'src', // And then build.outDir would be '../public' or '../dist'
  // For now, let's assume index.html moves to project root.

  // The server proxy is for local `vite dev` server, not directly used by Vercel build
  // but good to have if you ever run `vite dev` locally.
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000', // When running `vercel dev`
        changeOrigin: true,
      }
    }
  }
});