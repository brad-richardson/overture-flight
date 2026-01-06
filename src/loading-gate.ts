/**
 * Loading gate - stalls plane movement until minimum tiles are rendered
 * Provides a smoother startup experience by ensuring initial scene is populated
 */

import { LOADING_GATE } from './constants.js';

/**
 * Loading gate state management
 */
export class LoadingGate {
  private isReady = false;
  private loadedTileCount = 0;
  private readyCallbacks: (() => void)[] = [];
  private loadingOverlay: HTMLElement | null = null;
  private styleElement: HTMLStyleElement | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private minTiles: number = LOADING_GATE.MIN_TILES,
    private maxWaitMs: number = LOADING_GATE.MAX_WAIT_MS
  ) {}

  /**
   * Start the loading gate
   * Shows loading overlay and sets up timeout
   */
  start(): void {
    if (!LOADING_GATE.ENABLED) {
      this.isReady = true;
      return;
    }

    this.showLoadingOverlay();

    // Fallback timeout - don't block forever
    this.timeoutId = setTimeout(() => {
      if (!this.isReady) {
        console.warn('Loading gate timeout - proceeding without all tiles');
        this.setReady();
      }
    }, this.maxWaitMs);
  }

  /**
   * Called when a tile finishes loading
   */
  onTileLoaded(): void {
    if (this.isReady) return;

    this.loadedTileCount++;
    this.updateLoadingProgress();

    if (this.loadedTileCount >= this.minTiles) {
      this.setReady();
    }
  }

  /**
   * Mark the loading gate as ready
   */
  private setReady(): void {
    if (this.isReady) return;

    this.isReady = true;

    // Clear timeout
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // Hide overlay with animation
    this.hideLoadingOverlay();

    // Notify all waiting callbacks
    for (const callback of this.readyCallbacks) {
      callback();
    }
    this.readyCallbacks = [];
  }

  /**
   * Wait until the loading gate is ready
   * Returns immediately if already ready
   */
  waitUntilReady(): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.readyCallbacks.push(resolve);
    });
  }

  /**
   * Check if the loading gate is ready
   */
  getIsReady(): boolean {
    return this.isReady;
  }

  /**
   * Show the loading indicator (non-blocking, small indicator in corner)
   */
  private showLoadingOverlay(): void {
    this.loadingOverlay = document.createElement('div');
    this.loadingOverlay.id = 'loading-gate-indicator';
    this.loadingOverlay.innerHTML = `
      <div class="loading-spinner"></div>
      <span class="loading-text">Loading terrain...</span>
    `;

    // Add styles - small indicator in bottom-left corner
    this.styleElement = document.createElement('style');
    this.styleElement.textContent = `
      #loading-gate-indicator {
        position: fixed;
        bottom: 16px;
        left: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        padding: 8px 12px;
        border-radius: 6px;
        z-index: 10000;
        transition: opacity 0.3s ease-out;
      }

      #loading-gate-indicator .loading-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: loading-gate-spin 1s linear infinite;
      }

      @keyframes loading-gate-spin {
        to { transform: rotate(360deg); }
      }
    `;

    document.head.appendChild(this.styleElement);
    document.body.appendChild(this.loadingOverlay);
  }

  /**
   * Update the loading progress display
   */
  private updateLoadingProgress(): void {
    if (!this.loadingOverlay) return;

    const text = this.loadingOverlay.querySelector('.loading-text');
    if (text) {
      text.textContent = `Loading terrain... (${this.loadedTileCount}/${this.minTiles})`;
    }
  }

  /**
   * Hide the loading indicator with fade animation
   */
  private hideLoadingOverlay(): void {
    if (!this.loadingOverlay) return;

    this.loadingOverlay.style.opacity = '0';

    setTimeout(() => {
      this.loadingOverlay?.remove();
      this.loadingOverlay = null;
      this.styleElement?.remove();
      this.styleElement = null;
    }, 300);
  }

  /**
   * Reset the loading gate (for testing or re-initialization)
   */
  reset(): void {
    this.isReady = false;
    this.loadedTileCount = 0;
    this.readyCallbacks = [];

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    this.loadingOverlay?.remove();
    this.loadingOverlay = null;
    this.styleElement?.remove();
    this.styleElement = null;
  }
}

// Singleton instance
let gateInstance: LoadingGate | null = null;

/**
 * Get the global loading gate instance
 */
export function getLoadingGate(): LoadingGate {
  if (!gateInstance) {
    gateInstance = new LoadingGate();
  }
  return gateInstance;
}

/**
 * Reset the loading gate (for testing)
 */
export function resetLoadingGate(): void {
  if (gateInstance) {
    gateInstance.reset();
    gateInstance = null;
  }
}
