/**
 * Build information injected at build time
 *
 * These values are replaced by Vite during the build process.
 * The BUILD_HASH changes on each build, which automatically invalidates
 * the texture cache when a new version is deployed.
 *
 * In development mode, uses a fixed dev hash to maintain cache across reloads.
 */

// Injected by Vite at build time (see vite.config.ts)
// Uses ISO timestamp truncated to create a unique but readable hash
// Format: "20240115-143052" (date-time) or git short hash if available
export const BUILD_HASH: string = __BUILD_HASH__;

// Build timestamp (milliseconds since epoch)
export const BUILD_TIMESTAMP: number = __BUILD_TIMESTAMP__;

// Human-readable build date
export const BUILD_DATE: string = new Date(BUILD_TIMESTAMP).toISOString();

// TypeScript declarations for the injected globals
declare const __BUILD_HASH__: string;
declare const __BUILD_TIMESTAMP__: number;
