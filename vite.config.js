import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  // For GitHub Pages, set base to repository name
  // Update this if your repository has a different name
  base: mode === 'production' ? '/overture-flight/' : '/',
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
}));
