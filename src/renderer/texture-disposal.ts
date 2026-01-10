import * as THREE from 'three';

/**
 * WebGPU-safe texture disposal utility
 *
 * In WebGPU, textures cannot be disposed while they're still referenced by
 * pending GPU commands. This utility defers disposal until after the GPU
 * has finished processing.
 */

// Disposal queue for pending texture disposals
const disposeQueue: THREE.Texture[] = [];
let disposeScheduled = false;

// Whether to use deferred disposal (set based on renderer type)
let useDeferredDisposal = false;

/**
 * Enable or disable deferred disposal
 * Should be called after renderer is created
 */
export function setDeferredDisposal(enabled: boolean): void {
  useDeferredDisposal = enabled;
  if (enabled) {
    console.log('[TextureDisposal] Deferred disposal enabled for WebGPU');
  }
}

/**
 * Check if deferred disposal is enabled
 */
export function isDeferredDisposalEnabled(): boolean {
  return useDeferredDisposal;
}

/**
 * Dispose a texture safely (WebGPU-compatible)
 * If using WebGPU, defers disposal until GPU commands have completed
 */
export function disposeTexture(texture: THREE.Texture | null | undefined): void {
  if (!texture) return;

  if (useDeferredDisposal) {
    disposeQueue.push(texture);
    scheduleFlush();
  } else {
    texture.dispose();
  }
}

/**
 * Dispose a material safely (WebGPU-compatible)
 * If the material has a map texture, it will be disposed via the deferred queue
 */
export function disposeMaterial(material: THREE.Material | null | undefined): void {
  if (!material) return;

  // Check for map texture on standard materials
  if ('map' in material && (material as THREE.MeshStandardMaterial).map) {
    disposeTexture((material as THREE.MeshStandardMaterial).map);
  }

  // Dispose the material itself (materials don't have the same WebGPU timing issue)
  material.dispose();
}

/**
 * Schedule a flush of the disposal queue
 * Waits multiple animation frames to ensure GPU commands have completed.
 * WebGPU command buffers are async and may span several frames.
 */
function scheduleFlush(): void {
  if (disposeScheduled) return;
  disposeScheduled = true;

  // Wait 4 frames to ensure all GPU commands have completed
  // WebGPU command buffers can be queued across multiple frames
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          flushQueue();
        });
      });
    });
  });
}

/**
 * Flush the disposal queue
 */
function flushQueue(): void {
  // Copy queue and clear before disposing to avoid race conditions
  const toDispose = [...disposeQueue];
  disposeQueue.length = 0;
  disposeScheduled = false;

  for (const texture of toDispose) {
    texture.dispose();
  }
}

/**
 * Get the number of textures pending disposal
 */
export function getPendingDisposalCount(): number {
  return disposeQueue.length;
}
