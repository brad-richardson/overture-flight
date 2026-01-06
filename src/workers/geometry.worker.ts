/**
 * Web Worker for geometry creation
 * Offloads CPU-intensive geometry generation from the main thread
 */

import type { WorkerRequest, WorkerResponse } from './types.js';
import { buildBaseGeometry, getTransferableBuffers } from './geometry-builder.js';

/**
 * Handle incoming messages from the main thread
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'CAPABILITY_CHECK': {
        // Geometry workers don't need special capabilities
        const response: WorkerResponse = {
          type: 'CAPABILITY_CHECK_RESULT',
          id: request.id,
          supported: true,
        };
        self.postMessage(response);
        break;
      }

      case 'CREATE_BASE_GEOMETRY': {
        const { features, origin } = request.payload;

        // Build geometry buffers
        const result = buildBaseGeometry(features, origin);

        // Get transferable buffers for zero-copy transfer
        const transferables = getTransferableBuffers(result);

        const response: WorkerResponse = {
          type: 'CREATE_BASE_GEOMETRY_RESULT',
          id: request.id,
          result,
        };

        // Transfer ownership of buffers (zero-copy)
        self.postMessage(response, { transfer: transferables });
        break;
      }

      default: {
        // Handle texture rendering requests (for compatibility with shared pool)
        // These should go to the texture worker, not geometry worker
        const response: WorkerResponse = {
          type: 'ERROR',
          id: (request as { id?: string }).id || 'unknown',
          error: `Geometry worker received unsupported request type: ${(request as { type?: string }).type}`,
        };
        self.postMessage(response);
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'ERROR',
      id: request.id,
      error: error instanceof Error ? error.message : 'Unknown error in geometry worker',
    };
    self.postMessage(response);
  }
};

// Signal that worker is ready
self.postMessage({ type: 'READY' });
