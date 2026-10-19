/**
 * Renderer + scene + lights + render loop, including the silhouette pass
 * service (layer 0 normal render, layer 1 depth-only occluders, layer 2
 * silhouettes drawn with `GreaterDepth` behind occluders).
 *
 * ## On-demand rendering
 *
 * The `requestAnimationFrame` loop keeps ticking, but its *body* is gated by a
 * {@link FrameScheduler}: a tick that has neither a pending
 * {@link RenderCore.requestRender} nor a held {@link RenderCore.addActiveSource}
 * only refreshes the timestamp and returns, so a static map costs nothing.
 * Note that the simulation only advances inside {@link RenderCore.step}:
 * anything that has to keep moving must hold a source.
 *
 * ## Shadow map
 *
 * The shadow map is **not** redrawn on every frame either. three's
 * `shadowMap.autoUpdate` is off and {@link ShadowUpdatePolicy} turns
 * `needsUpdate` on for the frames that need it — see `shadow-update.ts`.
 * Anything that changes shadow-casting content outside a frame hook must call
 * {@link RenderCore.requestShadowUpdate} (the scene API's `requestRender()`
 * already does).
 *
 * @module
 */

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  GreaterDepth,
  Group,
  HemisphereLight,
  MeshBasicMaterial,
  NoToneMapping,
  PCFShadowMap,
  Scene,
  WebGLRenderer,
  type Object3D,
} from 'three';
import type { RenderParams } from '../theme/params.js';
import type { CameraController } from './camera.js';
import { FrameScheduler } from './frame-scheduler.js';
import { DEFAULT_FRAME_CAPTURE_LIMIT, FrameCapture, type CapturedFrame } from './frame-capture.js';
import { SHADOW_INERT_SOURCES, ShadowUpdatePolicy, shadowMapSizeFor, type ShadowState } from './shadow-update.js';
import { SilhouetteRegistry } from './silhouette-registry.js';

/** Frame hook: `dt` seconds (clamped to 0.05), `t` total seconds. */
export type FrameHook = (dt: number, t: number) => void;

export const LAYER_DEFAULT = 0;
export const LAYER_OCCLUDER = 1;
export const LAYER_SILHOUETTE = 2;

/** Silhouette-through-buildings service (used by part 2 characters). */
export interface SilhouetteService {
  /** Enables/disables the extra passes. */
  enabled: boolean;
  /** Marks an object (and its meshes) as an occluder (e.g. building walls). */
  addOccluder(obj: Object3D): void;
  /** Puts an object on the silhouette layer only; draw it with {@link createMaterial}. */
  addSilhouette(obj: Object3D): void;
  /**
   * Releases a silhouette registered with {@link addSilhouette}. The two extra
   * passes stay on while any other silhouette is registered; removing an object
   * that was never added is a no-op.
   */
  removeSilhouette(obj: Object3D): void;
  /** Material that renders only where the object is hidden behind occluders. */
  createMaterial(color: number, opacity?: number): MeshBasicMaterial;
}

/** Point-in-time frame-budget counters (see {@link RenderCore.frameBudget}). */
export interface FrameBudget {
  /** Frames rendered since the last {@link RenderCore.resetFrameBudget}. */
  frames: number;
  /** Frames that redrew the shadow map. */
  shadowRedraws: number;
  /** Passes the last frame ran: 1, or 3 while the silhouette passes are on. */
  passes: number;
  /**
   * Draw calls of the last frame. three resets `info.render.calls` inside every
   * `render()` call, so this is the sum over the frame's passes.
   */
  drawCalls: number;
  /** Draw calls accumulated since the last {@link RenderCore.resetFrameBudget}. */
  drawCallsTotal: number;
  /** Tags currently holding the loop awake. */
  activeSources: string[];
}

/**
 * One frame recorded by {@link RenderCore.startFrameCapture}. The shape lives in
 * {@link FrameCapture}, which owns the buffer; it is re-exported here so the
 * scene API and the app keep one import path.
 */
export type { CapturedFrame } from './frame-capture.js';
export { DEFAULT_FRAME_CAPTURE_LIMIT } from './frame-capture.js';

export class RenderCore {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly world = new Group();
  readonly hemi = new HemisphereLight(0xffffff, 0xb9c3da, 0.9);
  readonly sun = new DirectionalLight(0xfff3e0, 2.2);
  readonly silhouette: SilhouetteService;
  readonly anisotropy: number;
  sunDir: [number, number, number] = [30, 30, 24];
  /** Frames rendered over the engine's lifetime. Never reset (`SceneApi.frames`). */
  frames = 0;
  /** Frames rendered since the last {@link resetFrameBudget}; the measurement window. */
  windowFrames = 0;
  /** Frames whose shadow map was redrawn (see {@link frameBudget}). */
  shadowRedraws = 0;
  /** Passes the last frame ran: 1, or 3 while the silhouette passes are on. */
  passes = 0;
  /** Draw calls of the last frame (see {@link frameBudget}). */
  drawCalls = 0;
  /** Draw calls accumulated since {@link resetFrameBudget}. */
  drawCallsTotal = 0;
  private hooks = new Set<FrameHook>();
  private renderHooks = new Set<FrameHook>();
  private raf = 0;
  private last = 0;
  private time = 0;
  private running = false;
  private contextLost = false;
  private captureRedrawMark = 0;
  private readonly capture = new FrameCapture();
  private readonly scheduler = new FrameScheduler();
  private readonly shadows = new ShadowUpdatePolicy();
  private readonly silhouettes = new SilhouetteRegistry();
  private readonly canvas: HTMLCanvasElement;
  private readonly depthOnly = new MeshBasicMaterial({ colorWrite: false });
  /** Reused per frame: {@link ShadowUpdatePolicy.next} does not retain the state it is given. */
  private readonly shadowState: ShadowState = { enabled: false, x: 0, z: 0, dirX: 0, dirY: 0, dirZ: 0, extent: 0, far: 0, moving: false };

  constructor(canvas: HTMLCanvasElement, private readonly cam: CameraController) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    const r = this.renderer;
    r.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    r.autoClear = false;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    // The shadow map is redrawn on demand (see `shadow-update.ts`), not once per `render()` call.
    r.shadowMap.autoUpdate = false;
    this.anisotropy = Math.min(8, r.capabilities.getMaxAnisotropy());

    this.scene.fog = new Fog(0xd9dfe0, 45, 150);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.world);
    this.sun.castShadow = true;
    const size = shadowMapSizeFor(globalThis.navigator?.userAgent);
    this.sun.shadow.mapSize.set(size, size);
    Object.assign(this.sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 160 });
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;

    const self = this;
    this.silhouette = {
      enabled: true,
      addOccluder(obj) {
        obj.traverse((o) => o.layers.enable(LAYER_OCCLUDER));
      },
      addSilhouette(obj) {
        obj.traverse((o) => o.layers.set(LAYER_SILHOUETTE));
        // Reference counted per object: the extra passes come on with the first
        // registered silhouette and off again when the last one is removed, so
        // re-registering the same object changes nothing.
        if (!self.silhouettes.add(obj)) return;
        // A new silhouette (and the first one, which turns the extra passes on) changes the picture.
        self.requestRender();
        self.requestShadowUpdate();
      },
      removeSilhouette(obj) {
        if (!self.silhouettes.remove(obj)) return;
        // The next frame is the first one that may skip the extra passes.
        self.requestRender();
      },
      createMaterial(color, opacity = 0.9) {
        return new MeshBasicMaterial({ color, depthFunc: GreaterDepth, depthWrite: false, fog: false, transparent: true, opacity });
      },
    };
  }

  applyTheme(p: RenderParams): void {
    const r = this.renderer;
    r.toneMapping = p.toneMapped ? ACESFilmicToneMapping : NoToneMapping;
    r.toneMappingExposure = p.exposure;
    r.setClearColor(new Color(p.clearColor));
    const fog = this.scene.fog as Fog;
    fog.color.set(p.fog.color);
    fog.near = p.fog.near;
    fog.far = p.fog.far;
    this.hemi.color.set(p.hemi.sky);
    this.hemi.groundColor.set(p.hemi.ground);
    this.hemi.intensity = p.hemi.intensity;
    this.sun.color.set(p.sun.color);
    this.sun.intensity = p.sun.intensity;
    this.sun.castShadow = p.shadows;
    this.sunDir = p.sun.dir;
    this.requestRender();
    // Lighting changed and the caller is about to rebuild the static world and the buildings.
    this.requestShadowUpdate();
  }

  /** Sets the drawing buffer size (CSS pixels). Reallocates the drawing buffer, so it always draws a frame. */
  resize(width: number, height: number): void {
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.cam.setViewport(width, height);
    this.requestRender();
  }

  /**
   * Renders one more frame. Idempotent within a frame: any number of calls
   * between two animation frames produce exactly one extra frame. Call it
   * after changing anything visible from outside a frame hook.
   */
  requestRender(): void {
    this.scheduler.request();
  }

  /**
   * Redraws the shadow map on the next frame. Call it (in addition to
   * {@link requestRender}) after adding, removing or moving anything that casts
   * or receives a shadow from outside a frame hook — a command, an async model,
   * a rebuilt world. Camera movement needs no call: the policy compares the
   * shadow camera itself.
   */
  requestShadowUpdate(): void {
    this.shadows.invalidate();
  }

  /**
   * Keeps rendering (and stepping the simulation) until the returned release
   * function is called. Releasing twice is a no-op, and holders of the same
   * `tag` are reference counted, so each holder releases its own hold.
   */
  addActiveSource(tag: string): () => void {
    return this.scheduler.addSource(tag);
  }

  /** Tags currently keeping the loop rendering (diagnostics and tests). */
  activeSources(): string[] {
    return this.scheduler.tags;
  }

  /**
   * Frame-budget counters for diagnostics. Allocates a snapshot (and the source
   * list), so read it from tooling — never from the frame path. `frames` is the
   * current measurement window; {@link frames} itself stays the lifetime count.
   */
  frameBudget(): FrameBudget {
    return {
      frames: this.windowFrames,
      shadowRedraws: this.shadowRedraws,
      passes: this.passes,
      drawCalls: this.drawCalls,
      drawCallsTotal: this.drawCallsTotal,
      activeSources: this.activeSources(),
    };
  }

  /**
   * Restarts the {@link frameBudget} measurement window. The lifetime
   * {@link frames} counter is deliberately left alone: it backs
   * `SceneApi.frames()`, and tooling resetting a window must not rewind it.
   */
  resetFrameBudget(): void {
    this.windowFrames = 0;
    this.shadowRedraws = 0;
    this.passes = 0;
    this.drawCalls = 0;
    this.drawCallsTotal = 0;
  }

  /**
   * Starts (or restarts) a bounded per-frame capture for offline attribution
   * (plan item M1). Off by default, so {@link step} allocates nothing until
   * tooling asks for it — a captured frame allocates one sample plus the source
   * list, which is why it is not left on.
   */
  startFrameCapture(limit: number = DEFAULT_FRAME_CAPTURE_LIMIT): CapturedFrame[] {
    const previous = this.capture.start(limit);
    this.captureRedrawMark = this.shadowRedraws;
    return previous;
  }

  /** Stops recording. Frames captured so far stay readable. */
  stopFrameCapture(): void {
    this.capture.stop();
  }

  /** Copies the captured frames, oldest first. Allocates. */
  capturedFrames(): CapturedFrame[] {
    return this.capture.frames();
  }

  /** True while this capture still has room for more frames. */
  get capturing(): boolean {
    return this.capture.capturing;
  }

  /** True while a frame is queued or a source is held (i.e. the engine is not idle). */
  get busy(): boolean {
    return this.scheduler.busy;
  }

  onFrame(hook: FrameHook): () => void {
    this.hooks.add(hook);
    return () => { this.hooks.delete(hook); };
  }

  /** Hooks run after the camera update, right before rendering (for screen-space projection). */
  onBeforeRender(hook: FrameHook): () => void {
    this.renderHooks.add(hook);
    return () => { this.renderHooks.delete(hook); };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const frameMs = Math.max(0, now - this.last);
      const dt = Math.min(0.05, frameMs / 1000);
      // `last` is refreshed even on a skipped frame, so `dt` never accumulates across an idle stretch.
      this.last = now;
      if (this.contextLost) return; // keep the pending request for the restore
      if (!this.scheduler.take()) return;
      this.step(dt, frameMs);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private readonly onContextLost = (e: Event): void => {
    // Without preventDefault the browser never fires `webglcontextrestored`.
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    // Full recovery (rebuilding GPU resources) is not implemented yet; at least draw again.
    this.requestRender();
    this.requestShadowUpdate();
  };

  /**
   * Runs hooks, updates the camera / sun and renders one frame. `frameMs` is the
   * unclamped interval between rAF ticks: `dt` clamps to 50ms to keep simulations
   * stable, but a capture must see the real wall time or a stall would read as a
   * perfect frame.
   */
  step(dt: number, frameMs: number = dt * 1000): void {
    this.time += dt;
    for (const h of [...this.hooks]) h(dt, this.time);
    this.cam.update(dt);
    const o = this.cam.orbit, d = this.sunDir;
    this.sun.position.set(o.x + d[0], d[1], o.z + d[2]);
    this.sun.target.position.set(o.x, 0, o.z);
    this.sun.target.updateMatrixWorld();
    for (const h of [...this.renderHooks]) h(dt, this.time);
    this.updateShadowMap();
    this.render();
    this.frames++;
    this.windowFrames++;
    this.captureFrame(frameMs);
  }

  /** Records one frame while a capture is armed. Allocates only while armed. */
  private captureFrame(frameMs: number): void {
    if (!this.capture.capturing) return;
    const redrawn = this.shadowRedraws !== this.captureRedrawMark;
    this.captureRedrawMark = this.shadowRedraws;
    this.capture.record({
      dt: frameMs,
      shadowRedrawn: redrawn,
      passes: this.passes,
      drawCalls: this.drawCalls,
      activeSources: this.activeSources(),
    });
  }

  /**
   * Decides whether this frame redraws the shadow map. Runs after the frame
   * hooks, so the held sources and the sun / shadow camera describe the frame
   * that is about to be drawn.
   */
  private updateShadowMap(): void {
    const sc = this.sun.shadow.camera, t = this.sun.target.position, d = this.sunDir, s = this.shadowState;
    s.enabled = this.sun.castShadow;
    s.x = t.x;
    s.z = t.z;
    s.dirX = d[0];
    s.dirY = d[1];
    s.dirZ = d[2];
    s.extent = sc.right;
    s.far = sc.far;
    s.moving = this.scheduler.hasSourceExcept(SHADOW_INERT_SOURCES);
    const need = this.shadows.next(s);
    if (need) this.shadowRedraws++;
    this.renderer.shadowMap.needsUpdate = need;
  }

  render(): void {
    const r = this.renderer, camera = this.cam.camera;
    r.clear();
    camera.layers.set(LAYER_DEFAULT);
    r.render(this.scene, camera);
    // three resets `info.render.calls` inside every `render()`, so the frame's
    // draw calls are the sum over the passes that just ran.
    let passes = 1, calls = r.info.render.calls;
    if (this.silhouette.enabled && this.silhouettes.active) {
      r.clearDepth();
      camera.layers.set(LAYER_OCCLUDER);
      this.scene.overrideMaterial = this.depthOnly;
      r.render(this.scene, camera);
      this.scene.overrideMaterial = null;
      calls += r.info.render.calls;
      camera.layers.set(LAYER_SILHOUETTE);
      r.render(this.scene, camera);
      passes = 3;
      calls += r.info.render.calls;
    }
    camera.layers.set(LAYER_DEFAULT);
    this.passes = passes;
    this.drawCalls = calls;
    this.drawCallsTotal += calls;
  }

  dispose(): void {
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.hooks.clear();
    this.renderHooks.clear();
    // Drop silhouette registrations with the scene: a disposed core must not keep
    // objects alive through the registry, and `enabled` is about to go with it.
    this.silhouettes.clear();
    this.depthOnly.dispose();
    this.renderer.dispose();
  }
}
