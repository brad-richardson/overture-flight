import { defineConfig } from 'vite';
import { execSync } from 'child_process';

function generateBuildHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
    return `${dateStr}-${timeStr}`;
  }
}

const buildTimestamp = Date.now();
const buildHash = generateBuildHash();

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  define: {
    __BUILD_HASH__: JSON.stringify(mode === 'development' ? 'dev' : buildHash),
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  }
}));
