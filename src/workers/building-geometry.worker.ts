/**
 * Web Worker for building geometry creation
 * Offloads CPU-intensive building extrusion from the main thread
 *
 * Benefits:
 * - No main thread blocking during building geometry generation
 * - Uses earcut for fast polygon triangulation (no Three.js dependency)
 * - Transfers Float32Array buffers (zero-copy)
 */

import type { WorkerRequest, WorkerResponse, CreateBuildingGeometryPayload } from './types.js';
import { buildBuildingGeometry, getBuildingTransferables } from './building-geometry-builder.js';

/**
 * Handle incoming messages from the main thread
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'CAPABILITY_CHECK': {
        // Building geometry workers don't need special capabilities
        const response: WorkerResponse = {
          type: 'CAPABILITY_CHECK_RESULT',
          id: request.id,
          supported: true,
        };
        self.postMessage(response);
        break;
      }

      case 'CREATE_BUILDING_GEOMETRY': {
        const payload = request.payload as CreateBuildingGeometryPayload;

        // Build geometry buffers
        const result = buildBuildingGeometry(payload);

        // Get transferable buffers for zero-copy transfer
        const transferables = getBuildingTransferables(result);

        const response: WorkerResponse = {
          type: 'CREATE_BUILDING_GEOMETRY_RESULT',
          id: request.id,
          result,
        };

        // Transfer ownership of buffers (zero-copy)
        self.postMessage(response, { transfer: transferables });
        break;
      }

      default: {
        const response: WorkerResponse = {
          type: 'ERROR',
          id: (request as { id?: string }).id || 'unknown',
          error: `Building geometry worker received unsupported request type: ${(request as { type?: string }).type}`,
        };
        self.postMessage(response);
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'ERROR',
      id: request.id,
      error: error instanceof Error ? error.message : 'Unknown error in building geometry worker',
    };
    self.postMessage(response);
  }
};

// Signal that worker is ready
self.postMessage({ type: 'READY' });
