export type ElevationPreloader = (
  lng: number,
  lat: number,
  radius: number
) => Promise<void>;

export interface StartupElevationCoordinatorOptions {
  lng: number;
  lat: number;
  preload: ElevationPreloader;
  requestFrame: (callback: FrameRequestCallback) => number;
  onWarmupError: (error: unknown) => void;
}

/** Keep the center elevation blocking while moving its neighbors past first render. */
export class StartupElevationCoordinator {
  private centerLoad: Promise<void> | null = null;
  private centerReady = false;
  private firstFrameScheduled = false;

  constructor(private readonly options: StartupElevationCoordinatorOptions) {}

  loadCenter(): Promise<void> {
    if (!this.centerLoad) {
      this.centerLoad = this.options
        .preload(this.options.lng, this.options.lat, 0)
        .then(() => {
          this.centerReady = true;
        });
    }
    return this.centerLoad;
  }

  scheduleFirstFrame(firstFrame: FrameRequestCallback): void {
    if (!this.centerReady) {
      throw new Error('Center elevation must finish loading before the first frame');
    }
    if (this.firstFrameScheduled) return;
    this.firstFrameScheduled = true;

    this.options.requestFrame(time => {
      firstFrame(time);

      // Start in a microtask after the frame callback and contain every failure.
      void Promise.resolve()
        .then(() => this.options.preload(this.options.lng, this.options.lat, 2))
        .catch(this.options.onWarmupError);
    });
  }
}
