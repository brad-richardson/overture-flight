import { defineConfig } from 'vite';
import { execSync } from 'child_process';

/**
 * Generate a build hash for cache invalidation
 * Uses git commit hash if available, otherwise falls back to timestamp
 */
function generateBuildHash(): string {
  try {
    // Try to get the short git commit hash
    const gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    return gitHash;
  } catch {
    // Fallback to timestamp-based hash if git is not available
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
    return `${dateStr}-${timeStr}`;
  }
}

// Generate build info at config time (runs once per build)
const buildTimestamp = Date.now();
const buildHash = generateBuildHash();

export default defineConfig(({ mode }) => ({
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
  // Inject build information for cache invalidation
  // In dev mode, use a fixed hash to keep cache stable across HMR reloads
  define: {
    __BUILD_HASH__: JSON.stringify(mode === 'development' ? 'dev' : buildHash),
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  }
}));
