import { defineConfig } from 'vite';
import path from 'path';

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
  },
  resolve: {
    alias: {
      // Point to the JS client's dist folder within the monorepo
      'overture-geocoder': path.resolve(__dirname, 'node_modules/overture-geocoder/clients/js/dist/index.mjs')
    }
  }
}));
