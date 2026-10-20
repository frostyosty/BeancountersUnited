import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
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
