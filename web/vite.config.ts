/**
 * Build/dev-server configuration for the web app (Vite).
 *
 * - Plugins: React (JSX + fast refresh) and Tailwind 4 (utility CSS classes).
 * - Dev: the page is served on port 5173 and every `/api` request is forwarded to the shop server on port 4300,
 *   so the browser sees one origin and no CORS setup is needed. In production the server serves `web/dist`
 *   itself, so the same relative `/api/...` URLs keep working.
 * - Build: output goes to `web/dist` (emptied first so stale files never linger).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:4300', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
