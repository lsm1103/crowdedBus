import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    open: false
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 4096
  }
});
