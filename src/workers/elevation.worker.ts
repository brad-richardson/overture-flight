/**
 * Web Worker for elevation tile decoding
 * Offloads CPU-intensive Terrarium PNG decoding from the main thread
 * Uses OffscreenCanvas for image processing in worker context
 */

import type { WorkerRequest, WorkerResponse, DecodeElevationResult } from './types.js';

// Check if OffscreenCanvas is available
const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

/**
 * Decode Terrarium RGB values to height in meters
 * Formula: height = (R * 256 + G + B/256) - 32768
 */
function decodeTerrarium(r: number, g: number, b: number, offset: number): number {
  return (r * 256 + g + b / 256) - offset;
}

/**
 * Fetch image as ImageBitmap (works in worker context)
 */
async function fetchImageBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Decode elevation tile from URL
 * Uses OffscreenCanvas to extract pixel data and convert to heights
 */
async function decodeElevationTile(
  url: string,
  tileSize: number,
  terrariumOffset: number
): Promise<DecodeElevationResult> {
  // Fetch image as ImageBitmap
  const bitmap = await fetchImageBitmap(url);

  // Create OffscreenCanvas and draw image
  const canvas = new OffscreenCanvas(tileSize, tileSize);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2d context from OffscreenCanvas');
  }

  ctx.drawImage(bitmap, 0, 0, tileSize, tileSize);
  bitmap.close(); // Free memory

  // Extract pixel data
  const imageData = ctx.getImageData(0, 0, tileSize, tileSize);
  const heights = new Float32Array(tileSize * tileSize);

  // Decode Terrarium RGB values to heights
  for (let i = 0; i < tileSize * tileSize; i++) {
    const r = imageData.data[i * 4];
    const g = imageData.data[i * 4 + 1];
    const b = imageData.data[i * 4 + 2];
    heights[i] = decodeTerrarium(r, g, b, terrariumOffset);
  }

  return { heights };
}

/**
 * Handle incoming messages from the main thread
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'CAPABILITY_CHECK': {
        // Check if OffscreenCanvas is available
        const response: WorkerResponse = {
          type: 'CAPABILITY_CHECK_RESULT',
          id: request.id,
          supported: hasOffscreenCanvas,
        };
        self.postMessage(response);
        break;
      }

      case 'DECODE_ELEVATION': {
        if (!hasOffscreenCanvas) {
          throw new Error('OffscreenCanvas not supported in this worker');
        }

        const { url, tileSize, terrariumOffset } = request.payload;

        // Decode elevation tile
        const result = await decodeElevationTile(url, tileSize, terrariumOffset);

        // Transfer the heights buffer (zero-copy)
        const response: WorkerResponse = {
          type: 'DECODE_ELEVATION_RESULT',
          id: request.id,
          result,
        };

        self.postMessage(response, { transfer: [result.heights.buffer] });
        break;
      }

      default: {
        const response: WorkerResponse = {
          type: 'ERROR',
          id: (request as { id?: string }).id || 'unknown',
          error: `Elevation worker received unsupported request type: ${(request as { type?: string }).type}`,
        };
        self.postMessage(response);
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'ERROR',
      id: request.id,
      error: error instanceof Error ? error.message : 'Unknown error in elevation worker',
    };
    self.postMessage(response);
  }
};

// Signal that worker is ready
self.postMessage({ type: 'READY' });
