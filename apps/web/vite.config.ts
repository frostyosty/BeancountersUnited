import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { readSiteConfig, sitePlugin } from "./vite.site";

const site = readSiteConfig();
// Tests exercise the gate itself, so they always run with it on.
const gate = process.env.VITEST ? true : site.gate;

export default defineConfig({
  plugins: [react(), sitePlugin({ ...site, gate })],
  define: { __SITE_GATE__: JSON.stringify(gate) },
  test: {
    // Every file gets its own jsdom worker, so a loaded machine can push a render past the 5s default.
    testTimeout: 20_000,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
});
