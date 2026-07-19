import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Single source of truth for the API port — must match server/index.js's
// TODOS_PORT default (§2.3, F67).
const API_PORT = Number(process.env.TODOS_PORT) || 8787;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // PRESERVED — shadcn imports (@/lib/utils, @/components/ui/*) depend on it (F61).
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    strictPort: true, // pin dev to 5173; never silently shift to 5174 (F66)
    proxy: {
      // target derives from TODOS_PORT so a test/dev port move follows here too (F67)
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
});
