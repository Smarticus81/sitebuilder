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
    proxy: {
      '/api': WORKER,
      '/demos': WORKER,
      '/unsubscribe': WORKER,
    },
  },
});
