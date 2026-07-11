import type { PlaneState } from './plane.js';

export type MinimapLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type TeleportHandler = (lat: number, lng: number) => void;

export interface MinimapModule {
  initMinimap(onTeleport: TeleportHandler): void | Promise<void>;
  updateMinimap(planeState: PlaneState): void;
  openMinimap(): void;
}

export interface LazyMinimapControllerOptions {
  loadModule: () => Promise<MinimapModule>;
  onTeleport: TeleportHandler;
  onStatusChange?: (status: MinimapLoadStatus) => void;
}

/** Coordinates one lazy module instance without depending on the DOM or MapLibre. */
export class LazyMinimapController {
  private module: MinimapModule | null = null;
  private activation: Promise<void> | null = null;
  private latestPlaneState: PlaneState | null = null;
  private status: MinimapLoadStatus = 'idle';
  private onTeleport: TeleportHandler;

  constructor(private readonly options: LazyMinimapControllerOptions) {
    this.onTeleport = options.onTeleport;
  }

  getStatus(): MinimapLoadStatus {
    return this.status;
  }

  setTeleportHandler(onTeleport: TeleportHandler): void {
    this.onTeleport = onTeleport;
  }

  updatePlaneState(planeState: PlaneState): void {
    this.latestPlaneState = planeState;
    this.module?.updateMinimap(planeState);
  }

  activate(): Promise<void> {
    if (this.module) {
      try {
        this.module.openMinimap();
        return Promise.resolve();
      } catch (error) {
        this.module = null;
        this.setStatus('error');
        return Promise.reject(error);
      }
    }
    if (this.activation) return this.activation;

    this.setStatus('loading');
    const activation = (async () => {
      try {
        const module = await this.options.loadModule();
        await module.initMinimap((lat, lng) => this.onTeleport(lat, lng));
        if (this.latestPlaneState) module.updateMinimap(this.latestPlaneState);
        module.openMinimap();
        this.module = module;
        this.setStatus('ready');
      } catch (error) {
        this.module = null;
        this.setStatus('error');
        throw error;
      } finally {
        this.activation = null;
      }
    })();
    this.activation = activation;
    return activation;
  }

  private setStatus(status: MinimapLoadStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}

interface MinimapBinding {
  controller: LazyMinimapController;
  button: HTMLButtonElement;
  clickHandler: () => void;
}

let binding: MinimapBinding | null = null;

function updateButtonStatus(button: HTMLButtonElement, status: MinimapLoadStatus): void {
  const isLoading = status === 'loading';
  // Keep the control focusable while loading; repeated activations coalesce below.
  button.setAttribute('aria-disabled', String(isLoading));
  button.setAttribute('aria-busy', String(isLoading));
  button.dataset.loadState = status;

  if (isLoading) {
    button.title = 'Loading Map…';
    button.setAttribute('aria-label', 'Loading navigation map');
  } else if (status === 'error') {
    button.title = 'Map failed to load. Click to retry.';
    button.setAttribute('aria-label', 'Retry opening navigation map');
  } else {
    button.title = 'Open Map';
    button.setAttribute('aria-label', 'Open navigation map');
  }
}

/** Bind the lightweight globe-button controller during normal app startup. */
export function initLazyMinimap(onTeleport: TeleportHandler): void {
  if (binding) {
    binding.controller.setTeleportHandler(onTeleport);
    return;
  }

  const button = document.getElementById('globe-btn');
  if (!(button instanceof HTMLButtonElement)) {
    console.warn('Minimap globe button not found');
    return;
  }

  const controller = new LazyMinimapController({
    loadModule: () => import('./minimap.js'),
    onTeleport,
    onStatusChange: status => updateButtonStatus(button, status),
  });
  const clickHandler = (): void => {
    void controller.activate().catch(error => {
      console.error('Failed to load minimap:', error);
    });
  };

  button.addEventListener('click', clickHandler);
  updateButtonStatus(button, 'idle');
  binding = { controller, button, clickHandler };
}

/** Store state cheaply before load and forward it once the minimap is ready. */
export function updateLazyMinimap(planeState: PlaneState): void {
  binding?.controller.updatePlaneState(planeState);
}

function disposeLazyMinimapBinding(): void {
  if (!binding) return;
  binding.button.removeEventListener('click', binding.clickHandler);
  binding = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeLazyMinimapBinding);
}
