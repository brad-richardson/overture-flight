import * as THREE from 'three';

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
 *
 * Note: GPU terrain displacement now works with both WebGL (onBeforeCompile)
 * and WebGPU (TSL nodes), so no fallback is required.
 */
export async function createRenderer(options: {
  antialias?: boolean;
} = {}): Promise<RendererResult> {
  // Check URL param first (allows client-side override)
  const urlParams = new URLSearchParams(window.location.search);
  const webgpuParam = urlParams.get('webgpu');
  const webgpuDisabledByParam = webgpuParam === '0';

  const preferWebGPU = !webgpuDisabledByParam && import.meta.env.VITE_PREFER_WEBGPU !== 'false';

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
