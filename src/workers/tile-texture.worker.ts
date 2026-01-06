/**
 * Web Worker for tile texture rendering
 * Offloads CPU-intensive canvas operations from the main thread
 */

import type { WorkerRequest, WorkerResponse } from './types.js';
import { renderTileTextureToCanvas, renderLowDetailTextureToCanvas } from './offscreen-renderer.js';

// Test OffscreenCanvas capability on worker startup
let offscreenCanvasSupported = false;
try {
  const testCanvas = new OffscreenCanvas(1, 1);
  const testCtx = testCanvas.getContext('2d');
  offscreenCanvasSupported = testCtx !== null;
} catch {
  offscreenCanvasSupported = false;
}

/**
 * Handle incoming messages from the main thread
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'CAPABILITY_CHECK': {
        const response: WorkerResponse = {
          type: 'CAPABILITY_CHECK_RESULT',
          id: request.id,
          supported: offscreenCanvasSupported,
        };
        self.postMessage(response);
        break;
      }

      case 'RENDER_TILE_TEXTURE': {
        if (!offscreenCanvasSupported) {
          const response: WorkerResponse = {
            type: 'ERROR',
            id: request.id,
            error: 'OffscreenCanvas not supported in this worker',
          };
          self.postMessage(response);
          return;
        }

        const { baseFeatures, transportFeatures, bounds, textureSize } = request.payload;

        // Create OffscreenCanvas and render
        const canvas = new OffscreenCanvas(textureSize, textureSize);
        renderTileTextureToCanvas(canvas, baseFeatures, transportFeatures, bounds);

        // Transfer ImageBitmap back to main thread (zero-copy)
        const bitmap = canvas.transferToImageBitmap();
        const response: WorkerResponse = {
          type: 'RENDER_TILE_TEXTURE_RESULT',
          id: request.id,
          result: bitmap,
        };
        self.postMessage(response, { transfer: [bitmap] });
        break;
      }

      case 'RENDER_LOW_DETAIL_TEXTURE': {
        if (!offscreenCanvasSupported) {
          const response: WorkerResponse = {
            type: 'ERROR',
            id: request.id,
            error: 'OffscreenCanvas not supported in this worker',
          };
          self.postMessage(response);
          return;
        }

        const { baseFeatures, bounds, textureSize } = request.payload;

        // Create OffscreenCanvas and render
        const canvas = new OffscreenCanvas(textureSize, textureSize);
        renderLowDetailTextureToCanvas(canvas, baseFeatures, bounds);

        // Transfer ImageBitmap back to main thread (zero-copy)
        const bitmap = canvas.transferToImageBitmap();
        const response: WorkerResponse = {
          type: 'RENDER_LOW_DETAIL_TEXTURE_RESULT',
          id: request.id,
          result: bitmap,
        };
        self.postMessage(response, { transfer: [bitmap] });
        break;
      }

      default: {
        const response: WorkerResponse = {
          type: 'ERROR',
          id: (request as { id?: string }).id || 'unknown',
          error: `Unknown request type: ${(request as { type?: string }).type}`,
        };
        self.postMessage(response);
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'ERROR',
      id: request.id,
      error: error instanceof Error ? error.message : 'Unknown error in worker',
    };
    self.postMessage(response);
  }
};

// Signal that worker is ready
self.postMessage({ type: 'READY' });
