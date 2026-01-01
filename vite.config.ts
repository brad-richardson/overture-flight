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
    sourcemap: true,
    rollupOptions: {
      // Externalize optional duckdb-wasm dependency (used for geometry fetching, not needed for search)
      external: ['@duckdb/duckdb-wasm']
    }
  },
  resolve: {
    alias: {
      'overture-geocoder': path.resolve(__dirname, 'node_modules/overture-geocoder/clients/js/src/index.ts')
    }
  },
  optimizeDeps: {
    include: ['overture-geocoder'],
    exclude: ['@duckdb/duckdb-wasm']
  }
}));
