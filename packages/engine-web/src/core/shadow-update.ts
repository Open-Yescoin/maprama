/**
 * When the shadow map has to be re-rendered.
 *
 * three redraws the whole shadow map inside every `renderer.render()` call
 * while `renderer.shadowMap.autoUpdate` is true. For this engine that is almost
 * always wasted work: the map is a 2048² (1024² on mobile) depth pass over the
 * entire town, and most frames change nothing that casts or receives a shadow —
 * a camera that only rotates or zooms, a holo label fading in, a frame drawn
 * only to move DOM overlays.
 *
 * {@link ShadowUpdatePolicy} decides, once per frame, whether the map is still
 * valid. It is conservative by construction: it re-renders unless it can see
 * that *nothing* relevant moved, and three signals feed it.
 *
 * 1. **Explicit invalidation** ({@link ShadowUpdatePolicy.invalidate}) for
 *    content changes that happen outside a frame — every dispatched command,
 *    a theme / world rebuild, a glTF model that finished loading, a restored
 *    WebGL context. In the engine this rides along with `requestRender()`,
 *    which those paths already call.
 * 2. **Transform comparison** for the shadow camera itself: the sun follows the
 *    map camera target, and the zoom-out controller widens the shadow frustum,
 *    so panning and zooming out are detected by comparing the values that were
 *    in effect when the map was last drawn.
 * 3. **Active render sources** for things that keep moving frame after frame
 *    (characters, vehicles, drops, a bouncing building). Every tag counts
 *    except the ones in {@link SHADOW_INERT_SOURCES}, which are known not to
 *    touch the 3D scene; an unknown tag (a third-party `addActiveSource`)
 *    counts, so extensions are safe by default.
 *
 * Pure (no three.js, no DOM) so the decision can be unit-tested.
 *
 * @module
 */

/**
 * Active-source tags that provably cannot change the shadow map.
 *
 * The shadow camera is compared independently by {@link ShadowUpdatePolicy}
 * over `x`, `z`, `dirX`, `dirY`, `dirZ` and the frustum `extent` / `far`, and
 * the sun is re-derived from the map camera target every frame, so each tag
 * below is inert for a concrete reason:
 *
 * - `labels` / `infoCards` only animate DOM cards above the canvas;
 * - `camera:change` only keeps the loop alive until a throttled event goes out;
 * - `camera:idle` only emits that one throttled event after the tail delay;
 * - `camera` / `zoomOut` move the **viewer**: zoom-out writes the shadow
 *   camera's `extent` / `far` itself and a pan moves the sun target (`x` / `z`),
 *   both of which `same()` already detects, while a pure rotation, pitch or
 *   near zoom leaves the shadow map valid because no shadow caster moved.
 *
 * `view` (the 2D / 2.5D flatten transition) is deliberately **not** in this
 * set, even though it also only moves the viewer: `engine.ts` feeds
 * `zoomOut.scaleY * (1 - view.t)` to `BuildingRenderer.step` every frame, so
 * the transition scales every building — a shadow caster — while leaving the
 * shadow camera untouched. Treating it as inert would freeze the depth map and
 * leave flattened-building shadows behind after a 2D → 2.5D switch.
 *
 * Avatar sprites never cast shadows. Building colour/glow animation uses
 * `buildings`; geometry motion separately holds `building:shadow` (including
 * the final bounce/height frame). Neither colour-only tag changes depth.
 * Entity tags (characters, vehicles, drops, geofences, traffic, location,
 * building:shadow) move shadow casters and must stay out of this set. Every
 * other tag — including unknown ones — is treated as scene motion, so
 * extensions are safe by default.
 *
 * Because `addActiveSource(tag)` is public, the names below are **reserved**:
 * a new caller that animates a shadow caster must not borrow `camera` or
 * `zoomOut` (or any other name here) for it, since inertness is matched by
 * string. An unfamiliar tag is always the safe choice.
 */
export const SHADOW_INERT_SOURCES: ReadonlySet<string> = new Set([
  'labels',
  'infoCards',
  'camera:change',
  'camera:idle',
  'camera',
  'zoomOut',
  'avatars',
  'buildings',
]);

/** Everything about a frame that can invalidate the shadow map by itself. */
export interface ShadowState {
  /** `false` while the sun casts no shadows at all (theme without shadows). */
  enabled: boolean;
  /** Shadow camera focus (the sun follows the map camera target). */
  x: number;
  z: number;
  /** Sun direction from the theme. */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** Orthographic half-extent of the shadow frustum (widened by zoom-out). */
  extent: number;
  /** Far plane of the shadow frustum (widened by zoom-out). */
  far: number;
  /** True while something that can cast or receive a shadow is still moving. */
  moving: boolean;
}

const same = (a: ShadowState, b: ShadowState): boolean =>
  a.x === b.x && a.z === b.z && a.dirX === b.dirX && a.dirY === b.dirY && a.dirZ === b.dirZ && a.extent === b.extent && a.far === b.far;

export class ShadowUpdatePolicy {
  private dirty = true;
  private wasMoving = false;
  private last: ShadowState | null = null;

  /** Forces the next frame to redraw the shadow map (scene content changed). */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Decides whether the frame about to be drawn needs a fresh shadow map, and
   * records the state it was drawn with. Call exactly once per rendered frame,
   * after the frame hooks ran (so the active sources describe this frame).
   */
  next(state: ShadowState): boolean {
    if (!state.enabled) {
      // Re-enabling shadows has to redraw: `last` no longer describes anything on screen.
      this.last = null;
      this.wasMoving = false;
      return false;
    }
    // `wasMoving` covers the frame on which a subsystem stops: it releases its source inside the
    // frame hooks, i.e. *before* this runs, while the motion it just applied is still being drawn.
    const need = this.dirty || state.moving || this.wasMoving || !this.last || !same(this.last, state);
    this.wasMoving = state.moving;
    if (!need) return false;
    this.dirty = false;
    this.last = { ...state };
    return true;
  }
}

/** Shadow map resolution on a desktop-class device. */
export const SHADOW_MAP_SIZE = 2048;
/** Shadow map resolution on a phone / tablet, where the fill cost of the depth pass hurts most. */
export const SHADOW_MAP_SIZE_MOBILE = 1024;

/**
 * Shadow map resolution for the device the engine runs on. Phones and tablets
 * (which is where the engine runs inside a WebView) get a quarter of the
 * texels: the depth pass is pure fill, and at a phone's viewport the 1024² map
 * still lands close to one shadow texel per device pixel. Desktop browsers —
 * including the headless Chrome that produces the reference screenshots — keep
 * the full 2048², so the committed screenshots are unchanged.
 */
export function shadowMapSizeFor(userAgent: string | undefined): number {
  return userAgent && /Android|iPhone|iPad|iPod|Mobile/.test(userAgent) ? SHADOW_MAP_SIZE_MOBILE : SHADOW_MAP_SIZE;
}
