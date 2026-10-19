/**
 * Bounded per-frame capture buffer (plan item M1).
 *
 * The renderer knows per frame what a measurement needs — frame time, whether
 * the shadow map was redrawn, how many passes ran, the draw-call count and the
 * held source tags — but keeping that history always-on would allocate on every
 * frame. This buffer is therefore off until something arms it, and refuses
 * samples once its bound is reached so a forgotten capture cannot grow without
 * limit.
 *
 * It is deliberately free of three.js and DOM dependencies so the contract
 * (bound, restart, "previous capture comes back") is unit-testable in node.
 *
 * @module
 */

/** Frames a capture records by default: ~10s at 60fps, enough for one interaction. */
export const DEFAULT_FRAME_CAPTURE_LIMIT = 600;

/**
 * One frame as recorded by {@link FrameCapture}. The field names match the trace
 * analyser's `FrameSample` (`scripts/map-trace-analyze-core.ts`) so a capture can
 * be written to JSON and analysed as-is. That analyser also accepts an optional
 * `entityCounts`, which the renderer cannot know — it is owned by the feature
 * modules, and is left absent rather than invented here.
 */
export interface CapturedFrame {
  /** Frame duration in milliseconds, measured between rAF ticks (not clamped). */
  dt: number;
  /** Whether this frame redrew the shadow map. */
  shadowRedrawn: boolean;
  /** Passes submitted: 1 = main only, 3 = main + depth pass + silhouette pass. */
  passes: number;
  /** Draw calls summed over this frame's passes, as reported by three. */
  drawCalls: number;
  /** Frame sources that held the loop open for this frame. */
  activeSources: string[];
}

export class FrameCapture {
  private samples: CapturedFrame[] = [];
  private limit = 0;

  /**
   * Arms the capture for the next `limit` frames and returns the samples a
   * previous capture had collected, so re-arming cannot silently drop a
   * measurement that was never read.
   */
  start(limit: number = DEFAULT_FRAME_CAPTURE_LIMIT): CapturedFrame[] {
    const previous = this.samples;
    this.samples = [];
    this.limit = Math.max(0, Math.floor(limit));
    return previous;
  }

  /** Stops recording. Samples already recorded stay readable. */
  stop(): void {
    this.limit = 0;
  }

  /** Records one frame. A no-op while stopped or once the bound is reached. */
  record(sample: CapturedFrame): void {
    if (this.limit === 0 || this.samples.length >= this.limit) return;
    this.samples.push(sample);
  }

  /** Copies the samples, oldest first. Allocates. */
  frames(): CapturedFrame[] {
    return this.samples.slice();
  }

  /** True while this capture still has room for more frames. */
  get capturing(): boolean {
    return this.limit > 0 && this.samples.length < this.limit;
  }
}
