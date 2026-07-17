import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const WORKER = process.env.WORKER_URL ?? 'http://localhost:8787';

// Proxy API + demo previews + unsubscribe to the worker so the dashboard and
// demo iframes are same-origin (no CORS, demos load in the preview pane).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Listen on all interfaces so the dashboard is reachable from a phone on
    // the same Wi-Fi at http://<your-pc-ip>:5173. The phone only ever talks to
    // Vite; Vite proxies /api + /demos to the worker on the PC, so the worker
    // never needs to be exposed to the network.
    host: true,
    proxy: {
      '/api': WORKER,
      '/demos': WORKER,
      '/proposals': WORKER,
      '/beacon': WORKER,
      '/unsubscribe': WORKER,
    },
  },
});
