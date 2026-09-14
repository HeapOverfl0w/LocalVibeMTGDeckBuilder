import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/play': {
        target: 'ws://localhost:4000',
        ws: true,
        changeOrigin: true,
        // Only proxy WebSocket upgrades. Plain HTTP requests to /play (e.g. a
        // browser refresh or direct navigation) fall through to Vite's SPA
        // fallback so the client router renders the Play view instead of the
        // request reaching Express and 404-ing.
        bypass(req) {
          if (req.headers.upgrade === 'websocket') return undefined; // → proxy it
          return '/index.html'; // → serve the SPA shell
        },
      },
    },
  },
});