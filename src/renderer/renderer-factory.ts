import * as THREE from 'three';
import { ELEVATION } from '../constants.js';

export type RendererType = 'webgpu' | 'webgl';

export interface RendererResult {
  renderer: THREE.WebGLRenderer;
  type: RendererType;
}

/**
 * Create a renderer with WebGPU preference and WebGL fallback.
 *
 * WebGPU is preferred when:
 * - URL param ?webgpu=0 is NOT present (allows client-side override)
 * - VITE_PREFER_WEBGPU is not explicitly set to 'false'
 * - Browser supports WebGPU (navigator.gpu exists)
 * - WebGPU adapter can be acquired
 * - WebGPURenderer initializes successfully
 *
 * Falls back to WebGL if any of the above fail.
 */
export async function createRenderer(options: {
  antialias?: boolean;
} = {}): Promise<RendererResult> {
  // Check URL param first (allows client-side override)
  const urlParams = new URLSearchParams(window.location.search);
  const webgpuParam = urlParams.get('webgpu');
  const webgpuDisabledByParam = webgpuParam === '0';

  // Check for GPU displacement conflict - it uses onBeforeCompile which doesn't work with WebGPU
  const gpuDisplacementEnabled = ELEVATION.GPU_DISPLACEMENT;
  if (gpuDisplacementEnabled && !webgpuDisabledByParam) {
    console.warn('[Renderer] GPU terrain displacement (VITE_GPU_TERRAIN) is incompatible with WebGPU.');
    console.warn('[Renderer] Falling back to WebGL. Use ?webgpu=0 or disable VITE_GPU_TERRAIN to suppress this warning.');
  }

  const preferWebGPU = !webgpuDisabledByParam && !gpuDisplacementEnabled && import.meta.env.VITE_PREFER_WEBGPU !== 'false';

  if (preferWebGPU && 'gpu' in navigator) {
    try {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
      if (gpu) {
        const adapter = await gpu.requestAdapter();
        if (adapter) {
          // Dynamic import to avoid loading WebGPU code when not needed
          const { WebGPURenderer } = await import('three/webgpu');
          const renderer = new WebGPURenderer({
            antialias: options.antialias ?? false,
          });
          await renderer.init();
          console.log('[Renderer] Using WebGPU');
          // Cast to WebGLRenderer for type compatibility (APIs are similar)
          return { renderer: renderer as unknown as THREE.WebGLRenderer, type: 'webgpu' };
        }
      }
    } catch (e) {
      console.warn('[Renderer] WebGPU initialization failed, falling back to WebGL:', e);
    }
  }

  if (webgpuDisabledByParam) {
    console.log('[Renderer] Using WebGL (WebGPU disabled via ?webgpu=0)');
  } else {
    console.log('[Renderer] Using WebGL');
  }
  return {
    renderer: new THREE.WebGLRenderer({
      antialias: options.antialias ?? false,
    }),
    type: 'webgl',
  };
}
