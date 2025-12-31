import { defineConfig } from 'vite';

export default defineConfig(() => ({
  // Base path configuration:
  // - Vercel/Netlify: use '/' (default)
  // - GitHub Pages: set VITE_BASE_PATH='/overture-flight/'
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
}));
