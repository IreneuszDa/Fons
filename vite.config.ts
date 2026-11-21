import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Fons web app (src/web). `vite` serves index.html at the repo root; `vite build` writes web-dist/,
// which the Hono server serves in production. In dev, /api, /mcp and /metrics are proxied to the API on :8787.
// Bundle: the citizen chat is the entry; result, sources and the admin panel are lazy chunks (React.lazy).
// Stable vendor chunks (react, astryx) are split out so they cache across deploys.
export default defineConfig({
  root: ".",
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: false },
      "/mcp": { target: "http://localhost:8787", changeOrigin: false },
      "/metrics": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
});
