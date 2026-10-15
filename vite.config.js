import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the built site works from any folder or static host.
  base: './',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
