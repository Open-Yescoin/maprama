/**
 * `WorldAvatars` placement and lifecycle.
 *
 * Avatars are plain three.js sprites, so the module is driven here against a
 * stub `SceneApi` with a recording canvas: the assertions are about world
 * placement (including the roof anchor), fallback texturing and teardown, not
 * about pixels.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Scene, type Sprite } from 'three';
import { WebGLRenderLists } from 'three/src/renderers/webgl/WebGLRenderLists.js';
import { WebGLProperties } from 'three/src/renderers/webgl/WebGLProperties.js';
import type { LngLat } from '@open-yescoin/maprama-protocol';
import gsap from 'gsap';
import { avatarGeometry, drawAvatarDisc, drawAvatarFrame, WorldAvatars } from './avatars.js';
import type { AnchorContext } from '../labels/anchor.js';
import type { SceneApi } from '../scene-api.js';

afterEach(() => vi.unstubAllGlobals());

const ORIGIN: LngLat = { lng: 127, lat: 37.5 };
const calls: string[] = [];
const ctx = new Proxy({} as Record<string, unknown>, {
  get: (_t, key) => {
    if (['font', 'fillStyle', 'strokeStyle', 'lineWidth', 'textAlign', 'textBaseline'].includes(String(key))) return '';
    if (key === 'createLinearGradient' || key === 'createRadialGradient') {
      return () => ({ addColorStop: (..._a: unknown[]) => calls.push('addColorStop') });
    }
    return (..._a: unknown[]) => calls.push(String(key));
  },
});

/** Counts portrait loads, so a redundant re-request is observable. */
let imageRequests = 0;
function stubDom(): void {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) as unknown as HTMLCanvasElement,
    createElementNS: () => {
      imageRequests += 1;
      const img = { crossOrigin: '', onload: null as null | (() => void), onerror: null as null | (() => void), set src(_v: string) { queueMicrotask(() => img.onerror?.()); } };
      return img;
    },
  });
}

/**
 * A world with one building: footprints are in world units, 1° ≈ 1000 units.
 * `roofY` reports 7 for `b1`, which is what a roof anchor must use.
 */
function stubScene(reduceMotion = false) {
  const dynamic = new Group();
  const ctxAnchor: AnchorContext = {
    buildings: [{ id: 'b1', footprint: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }],
    roofY: (id) => (id === 'b1' ? 7 : null),
    groundY: 0.09,
  };
  let frameHook: ((dt: number, t: number) => void) | null = null;
  let release: (() => void) | null = null;
  const scene = {
    groups: { dynamic },
    reduceMotion,
    projection: () => ({ toWorld: (ll: LngLat) => ({ x: (ll.lng - ORIGIN.lng) * 1000, z: (ll.lat - ORIGIN.lat) * 1000 }), metersToUnits: (m: number) => m, unitsToMeters: (u: number) => u }),
    world: () => ({ kind: 'town' }),
    building: () => null,
    requestRender: () => {},
    onFrame: (hook: (dt: number, t: number) => void) => {
      frameHook = hook;
      return () => {
        frameHook = null;
      };
    },
    addActiveSource: () => {
      release = () => {
        release = null;
      };
      return release;
    },
  } as unknown as SceneApi;
  return {
    scene,
    dynamic,
    anchor: ctxAnchor,
    group: () => dynamic.children[0]!,
    /**
     * Drives the engine's frame hook, as the render loop would.
     *
     * `t` is **seconds**, matching `RenderCore.time` (`this.time += dt`, with `dt`
     * in seconds). Pass whole seconds — a period written as 3200 ms reaches its
     * halfway point at `t = 1.6`, not at `t = 1600`.
     */
    frameAt: (t: number) => frameHook?.(0.016, t),
    isAnimating: () => frameHook !== null,
    isReleased: () => release === null,
  };
}

describe('WorldAvatars', () => {
  it('stands a resident avatar on the roof of the building it snaps to', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'b1:0', coordinate: ORIGIN, fallbackLabel: 'L', widthMeters: 2.6, anchor: 'bottom', anchorHeight: 'roof', snapToBuilding: true },
    ]);
    const sprite = s.group().children[0]!;
    // Roof of `b1` is 7: a roof anchor must not fall back to ground (0.09).
    expect(sprite.position.y).toBeCloseTo(7, 5);
    expect(sprite.position.x).toBeCloseTo(0, 5);
    avatars.dispose();
  });

  it('falls back to the ground height when the avatar does not snap to a building', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'loose', coordinate: { lng: 127.05, lat: 37.5 }, fallbackLabel: 'X', anchorHeight: 'ground' },
    ]);
    const sprite = s.group().children[0]!;
    expect(sprite.position.y).toBeCloseTo(0.09, 5);
    avatars.dispose();
  });

  it('renders avatars without depth testing so a building cannot swallow them', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'roof', coordinate: ORIGIN, fallbackLabel: 'R', anchorHeight: 'roof', snapToBuilding: true },
    ]);
    const sprite = s.group().children[0]! as unknown as { material: { depthTest: boolean; depthWrite: boolean; transparent: boolean } };
    // A depth-tested quad on a roof is drawn over by the building mesh and looks
    // embedded in it; the DOM avatars it replaced were never occluded.
    expect(sprite.material.depthTest).toBe(false);
    expect(sprite.material.depthWrite).toBe(false);
    expect(sprite.material.transparent).toBe(true);
    avatars.dispose();
  });

  it.each([false, true])('composites each overlapping portrait with its own frame (same depth: %s)', async (sameDepth) => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    const specs = [
      { id: 'near', coordinate: ORIGIN, fallbackLabel: 'Near', z: 36 },
      { id: 'far', coordinate: { lng: ORIGIN.lng, lat: ORIGIN.lat + 0.01 }, fallbackLabel: 'Far', z: 36 },
    ];
    await avatars.setLayer('residents', specs);
    const [nearDisc, nearFrame, farDisc, farFrame] = s.group().children as Sprite[];
    const lists = new WebGLRenderLists(new WebGLProperties());
    const list = lists.get(new Scene(), 0);
    const drawOrder = () => {
      list.init();
      for (const sprite of s.group().children as Sprite[]) {
        const depth = sameDepth ? 1 : sprite.position.z;
        // three r186 adds a camera argument; its type declarations still use r185.
        Reflect.apply(list.push, list, [sprite, sprite.geometry, sprite.material, 0, depth, null, { reversedDepth: false }]);
      }
      Reflect.apply(list.sort, list, []);
      return list.transparent.map(item => item.object);
    };
    try {
      expect(drawOrder()).toEqual(sameDepth ? [nearDisc, nearFrame, farDisc, farFrame] : [farDisc, farFrame, nearDisc, nearFrame]);
      // A re-sent selected avatar still owns its whole rim, above the other pair.
      await avatars.setLayer('residents', specs.map(spec => ({ ...spec, z: spec.id === 'near' ? 48 : 36 })));
      expect(drawOrder()).toEqual([farDisc, farFrame, nearDisc, nearFrame]);
      avatars.refresh();
      expect(drawOrder()).toEqual([farDisc, farFrame, nearDisc, nearFrame]);
    } finally {
      lists.dispose();
      avatars.dispose();
    }
  });

  it('applies elevationMeters on top of the resolved roof anchor', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'lifted', coordinate: ORIGIN, fallbackLabel: 'L', anchorHeight: 'roof', snapToBuilding: true, elevationMeters: 1.2 },
    ]);
    expect(s.group().children[0]!.position.y).toBeCloseTo(7 + 1.2, 5);
    avatars.dispose();
  });

  it('applies brightness but clamps it at the 1.16 ceiling so the texture cannot blow out', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'dim', coordinate: ORIGIN, fallbackLabel: 'D', anchorHeight: 'roof', snapToBuilding: true, brightness: 0.7 },
      { id: 'over', coordinate: ORIGIN, fallbackLabel: 'O', anchorHeight: 'roof', snapToBuilding: true, brightness: 1.9 },
    ]);
    const kids = s.group().children as unknown as { material: { color: { r: number } } }[];
    // Each avatar is a disc plus a frame, so the discs are at even indices.
    const dim = kids[0]!, over = kids[2]!;
    // SpriteMaterial is unlit, so the colour multiplier is the only brightness lever.
    expect(dim.material.color.r).toBeCloseTo(0.7, 5);
    // Over-driving the colour is what made the old 1.9 multiplier look blown out;
    // the ceiling (1.16, see `setBrightness`) is what keeps a mild lift safe.
    expect(over.material.color.r).toBeCloseTo(1.16, 5);
    avatars.dispose();
  });

  it('sizes the sprite from widthMeters and offsets a centre-anchored avatar by half its height', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'a', coordinate: ORIGIN, fallbackLabel: 'A', widthMeters: 4, anchor: 'center', anchorHeight: 'roof', snapToBuilding: true },
    ]);
    const sprite = s.group().children[0]!;
    expect(sprite.scale.x).toBe(4);
    expect(sprite.scale.y).toBe(4);
    expect(sprite.position.y).toBeCloseTo(7 + 2, 5);
    avatars.dispose();
  });

  it('replaces a layer and removes only the replaced avatars', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'a', coordinate: ORIGIN, fallbackLabel: 'A', anchorHeight: 'roof', snapToBuilding: true },
      { id: 'b', coordinate: ORIGIN, fallbackLabel: 'B', anchorHeight: 'roof', snapToBuilding: true },
    ]);
    // Two avatars, each a disc + a frame.
    expect(s.group().children).toHaveLength(4);
    await avatars.setLayer('residents', [{ id: 'a', coordinate: ORIGIN, fallbackLabel: 'A', anchorHeight: 'roof', snapToBuilding: true }]);
    expect(s.group().children).toHaveLength(2);
    avatars.removeLayer('residents');
    expect(s.group().children).toHaveLength(0);
    avatars.dispose();
    expect(s.dynamic.children).toHaveLength(0);
  });

  it('bobs a floating avatar between its resting height and one amplitude up', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'float', coordinate: ORIGIN, fallbackLabel: 'F', anchorHeight: 'roof', snapToBuilding: true, elevationMeters: 1.2, float: { amplitudeMeters: 0.5, periodMs: 3200 } },
    ]);
    const sprite = s.group().children[0]!;
    expect(s.isAnimating()).toBe(true);

    // t = 0 → cos(0) = 1 → bob 0, i.e. the resting height.
    s.frameAt(0);
    expect(sprite.position.y).toBeCloseTo(8.2, 5);
    // Half a period (3200 ms = 3.2 s) later the cosine is -1 → full amplitude.
    s.frameAt(1.6);
    expect(sprite.position.y).toBeCloseTo(8.7, 5);
    // And back down at the end of the cycle.
    s.frameAt(3.2);
    expect(sprite.position.y).toBeCloseTo(8.2, 5);
    avatars.dispose();
  });

  it('starts an entrance faded, never collapsed, and restores full opacity without one', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('r', [
      { id: 'in', coordinate: ORIGIN, fallbackLabel: 'I', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4, entrance: { durationMs: 400 } },
    ]);
    const disc = s.group().children[0]! as unknown as { scale: { x: number }; material: { opacity: number } };
    const frame = s.group().children[1]!;
    // The entrance is a real fade + grow: it starts transparent...
    expect(disc.material.opacity).toBeLessThan(1);
    // ...but never invisible in size, so a decoration can never hide an avatar.
    expect(disc.scale.x).toBeGreaterThan(0);
    expect(frame.scale.x).toBe(disc.scale.x);
    avatars.dispose();
  });

  it('leaves an avatar at full size and opaque when no entrance is asked for', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('r', [
      { id: 'plain', coordinate: ORIGIN, fallbackLabel: 'P', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4 },
    ]);
    const disc = s.group().children[0]! as unknown as { scale: { x: number }; material: { opacity: number } };
    expect(disc.scale.x).toBe(4);
    expect(disc.material.opacity).toBe(1);
    avatars.dispose();
  });

  it('does not restart an entrance when the layer is re-sent mid-tween', async () => {
    vi.useFakeTimers();
    try {
      stubDom();
      const s = stubScene();
      const avatars = new WorldAvatars(s.scene, () => s.anchor);
      const spec = {
        id: 'in',
        coordinate: ORIGIN,
        fallbackLabel: 'I',
        anchorHeight: 'roof' as const,
        snapToBuilding: true,
        widthMeters: 4,
        entrance: { durationMs: 2000 },
      };
      await avatars.setLayer('r', [spec]);
      const disc = s.group().children[0]! as unknown as { scale: { x: number }; material: { opacity: number } };
      // One tick is enough to put the tween in charge of the transform: it starts
      // at a fifth of the resting size and fully transparent.
      gsap.ticker.tick();
      const before = disc.scale.x;
      const beforeOpacity = disc.material.opacity;
      expect(before).toBeLessThan(3);
      expect(beforeOpacity).toBeLessThan(0.5);
      // The app re-sends whole avatar layers (tapping a residence, closing the
      // roster), and that can land inside the entrance window. The id must be
      // claimed when the pop starts: if it is not, this re-send kills the tween
      // and `cancelEntrance` snaps the avatar back to its resting size and full
      // opacity before the entrance replays from scratch.
      await avatars.setLayer('r', [spec]);
      expect(disc.scale.x).toBe(before);
      expect(disc.material.opacity).toBe(beforeOpacity);
      avatars.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches a killed entrance from the render loop', async () => {
    vi.useFakeTimers();
    try {
      stubDom();
      const s = stubScene();
      const avatars = new WorldAvatars(s.scene, () => s.anchor);
      await avatars.setLayer('r', [
        { id: 'in', coordinate: ORIGIN, fallbackLabel: 'I', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4, entrance: { durationMs: 400 } },
      ]);
      // Removing the layer mid-flight must not leave a tween writing to a
      // sprite that is no longer in the scene.
      avatars.removeLayer('r');
      expect(() => gsap.ticker.tick()).not.toThrow();
      expect(s.group().children).toHaveLength(0);
      avatars.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts every avatar together when no entrance is asked for', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('r', [
      { id: 'a', coordinate: ORIGIN, fallbackLabel: 'A', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4 },
      { id: 'b', coordinate: ORIGIN, fallbackLabel: 'B', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4 },
    ]);
    // No entrance means no tween: both sit at their full size immediately.
    expect(s.group().children[0]!.scale.x).toBe(4);
    expect(s.group().children[2]!.scale.x).toBe(4);
    expect(s.isAnimating()).toBe(false);
    avatars.dispose();
  });

  it('does not replay the entrance when the same layer is re-sent', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    const spec = { id: 'a', coordinate: ORIGIN, fallbackLabel: 'A', anchorHeight: 'roof' as const, snapToBuilding: true, widthMeters: 6, entrance: { durationMs: 400 } };
    await avatars.setLayer('r', [spec]);
    s.frameAt(0);
    s.frameAt(400);
    const disc = s.group().children[0]!;
    expect(disc.scale.x).toBeCloseTo(6, 3);
    // The app re-sends this layer often. Re-arming the entrance on a reused
    // avatar would drop it back to zero scale and make it vanish.
    await avatars.setLayer('r', [spec]);
    expect(disc.scale.x).toBeCloseTo(6, 3);
    avatars.dispose();
  });

  it('gives a pulsing avatar a halo behind the disc', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'hot', coordinate: ORIGIN, fallbackLabel: 'H', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4, pulse: { periodMs: 2000, scale: 1.6 } },
    ]);
    // disc, frame, halo
    expect(s.group().children).toHaveLength(3);
    const halo = s.group().children[2]!;
    // Behind the disc, so the pulse reads as a halo rather than covering it.
    expect(halo.renderOrder).toBeLessThan(s.group().children[0]!.renderOrder);
    s.frameAt(0);
    const at0 = halo.scale.x;
    // Half of the 2000 ms period: the ring must have grown by now.
    s.frameAt(1);
    expect(halo.scale.x).toBeGreaterThan(at0);
    avatars.dispose();
    expect(s.dynamic.children).toHaveLength(0);
  });

  it('drops the halo entirely when a re-sent layer drops the pulse', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'hot', coordinate: ORIGIN, fallbackLabel: 'H', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4, pulse: { periodMs: 2000, scale: 1.6 } },
    ]);
    // disc, frame, halo
    expect(s.group().children).toHaveLength(3);
    const halo = s.group().children[2]!;
    // Deselecting the residence re-sends the same id without `pulse`. The frame
    // loop skips avatars that do not pulse, so `syncHalo` is the only place that
    // can clear the ring: without it the previous selection keeps its halo.
    await avatars.setLayer('residents', [
      { id: 'hot', coordinate: ORIGIN, fallbackLabel: 'H', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4 },
    ]);
    // Detached, not merely hidden: a hidden sprite would still be traversed by
    // the renderer and would keep its material alive.
    expect(s.group().children).toHaveLength(2);
    expect(halo.parent).toBeNull();
    avatars.dispose();
  });

  it('holds no frame hook for avatars that do not float', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'still', coordinate: ORIGIN, fallbackLabel: 'S', anchorHeight: 'roof', snapToBuilding: true },
    ]);
    // No bob means the on-demand render loop must stay idle.
    expect(s.isAnimating()).toBe(false);
    avatars.dispose();
  });

  it('stops animating and releases its active source once the avatars go away', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'float', coordinate: ORIGIN, fallbackLabel: 'F', anchorHeight: 'roof', snapToBuilding: true, float: { amplitudeMeters: 0.4 } },
    ]);
    expect(s.isAnimating()).toBe(true);
    avatars.removeLayer('residents');
    expect(s.isAnimating()).toBe(false);
    avatars.dispose();
  });

  it('does not re-request a portrait that already failed while it is cooling down', async () => {
    stubDom();
    imageRequests = 0;
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    const blocked = { id: 'blocked', coordinate: ORIGIN, uri: 'https://cdn.example.test/x.webp', fallbackLabel: 'B', anchorHeight: 'roof' as const, snapToBuilding: true };
    await avatars.setLayer('r', [blocked]);
    expect(imageRequests).toBe(1);
    // The app re-sends the layer constantly. Each re-send used to retry the
    // blocked URL (re-logging its CORS error) and swap the disc texture, which
    // flickered the avatar instead of leaving its fallback up.
    await avatars.setLayer('r', [blocked]);
    await avatars.setLayer('r', [blocked]);
    expect(imageRequests).toBe(1);
    // And the avatar is still on screen with its fallback disc.
    expect(s.group().children).toHaveLength(2);
    avatars.dispose();
  });

  it('retries a fallback portrait after the failed-image cooldown expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      stubDom();
      imageRequests = 0;
      const s = stubScene();
      const avatars = new WorldAvatars(s.scene, () => s.anchor);
      const blocked = { id: 'blocked', coordinate: ORIGIN, uri: 'https://cdn.example.test/x.webp', fallbackLabel: 'B', anchorHeight: 'roof' as const, snapToBuilding: true };
      await avatars.setLayer('r', [blocked]);
      expect(imageRequests).toBe(1);
      await avatars.setLayer('r', [blocked]);
      expect(imageRequests).toBe(1);
      now.mockReturnValue(31_001);
      await avatars.setLayer('r', [blocked]);
      expect(imageRequests).toBe(2);
      expect(s.group().children).toHaveLength(2);
      avatars.dispose();
    } finally {
      now.mockRestore();
    }
  });

  it('does not rebuild the disc when an unchanged layer is re-sent', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    const spec = { id: 'a', coordinate: ORIGIN, fallbackLabel: 'A', anchorHeight: 'roof' as const, snapToBuilding: true, widthMeters: 5 };
    await avatars.setLayer('r', [spec]);
    const disc = s.group().children[0]! as unknown as { material: { map: unknown } };
    const mapBefore = disc.material.map;
    await avatars.setLayer('r', [spec]);
    // Same texture instance: no dispose/rebuild churn on a redundant send.
    expect(disc.material.map).toBe(mapBefore);
    avatars.dispose();
  });

  it('keeps every avatar when a portrait URI fails to load (blocked CDN / missing CORS)', async () => {
    // `stubDom` errors every image request, which is what a portrait host
    // without CORS headers does in the browser. Previously one bad URI rejected
    // the whole `setLayer`, so no avatar rendered at all.
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await expect(
      avatars.setLayer('residents', [
        { id: 'blocked', coordinate: ORIGIN, uri: 'https://s3.example.test/5_1775106597827.webp', fallbackLabel: 'B', anchorHeight: 'roof', snapToBuilding: true },
        { id: 'plain', coordinate: ORIGIN, fallbackLabel: 'P', anchorHeight: 'roof', snapToBuilding: true },
      ]),
    ).resolves.toBeUndefined();
    // Both survive (disc + frame each): the blocked one falls back to its disc.
    expect(s.group().children).toHaveLength(4);
    avatars.dispose();
  });

  it('does not rewrite the sprite scale on a frame that leaves it unchanged', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'float', coordinate: ORIGIN, fallbackLabel: 'F', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4, elevationMeters: 1.2, float: { amplitudeMeters: 0.5, periodMs: 3200 } },
    ]);
    const sprite = s.group().children[0]!;
    const set = vi.spyOn(sprite.scale, 'set');
    s.frameAt(0);
    const y0 = sprite.position.y;
    // Half of the 3200 ms period, in the hook's seconds: the bob really ran...
    s.frameAt(1.6);
    expect(sprite.position.y).toBeGreaterThan(y0);
    // ...but the spec width did not change, so neither sprite's scale was rewritten.
    expect(set).not.toHaveBeenCalled();
    expect(sprite.scale.x).toBe(4);
    // Positive control: a re-send with a different width must still apply at
    // once, so the guard can never swallow a real change.
    await avatars.setLayer('residents', [
      { id: 'float', coordinate: ORIGIN, fallbackLabel: 'F', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 6, elevationMeters: 1.2, float: { amplitudeMeters: 0.5, periodMs: 3200 } },
    ]);
    expect(set).toHaveBeenCalled();
    expect(sprite.scale.x).toBe(6);
    avatars.dispose();
  });

  it('applies an entrance at its final transform immediately under reduced motion, without a tween', async () => {
    stubDom();
    const s = stubScene(true);
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('r', [
      { id: 'in', coordinate: ORIGIN, fallbackLabel: 'I', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4, elevationMeters: 1.2, entrance: { durationMs: 400 } },
    ]);
    const disc = s.group().children[0]! as unknown as { scale: { x: number }; material: { opacity: number }; position: { y: number } };
    const frame = s.group().children[1]!;
    // Reduced motion never applies the tween's zero/overshoot start: the avatar
    // is at its resting size, opacity and position from the first frame on.
    expect(disc.scale.x).toBe(4);
    expect(disc.material.opacity).toBe(1);
    expect(disc.position.y).toBeCloseTo(7 + 1.2, 5);
    expect(frame.scale.x).toBe(4);
    // And no frame hook is held waiting for a tween to run in.
    expect(s.isAnimating()).toBe(false);
    avatars.dispose();
  });

  it('never leaves an avatar at a zero or overshoot scale under reduced motion', async () => {
    stubDom();
    const s = stubScene(true);
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('r', [
      { id: 'in', coordinate: ORIGIN, fallbackLabel: 'I', anchorHeight: 'roof', snapToBuilding: true, entrance: { durationMs: 400 } },
    ]);
    const disc = s.group().children[0]! as unknown as { scale: { x: number } };
    // `easeOutBack` overshoots and the entrance starts well under 1; reduced
    // motion must skip both and leave the avatar fully visible.
    expect(disc.scale.x).toBeGreaterThan(0);
    expect(disc.scale.x).toBe(2.4);
    avatars.dispose();
  });

  it('holds no frame hook for a floating, pulsing avatar under reduced motion', async () => {
    stubDom();
    const s = stubScene(true);
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'hot', coordinate: ORIGIN, fallbackLabel: 'H', anchorHeight: 'roof', snapToBuilding: true, widthMeters: 4, float: { amplitudeMeters: 0.5 }, pulse: { periodMs: 2000, scale: 1.6 } },
    ]);
    // Neither the bob nor the halo pulse runs, so nothing may keep the
    // on-demand render loop awake.
    expect(s.isAnimating()).toBe(false);
    expect(s.isReleased()).toBe(true);
    // The attention ring is still applied, parked at the pulse peak so it is
    // not hidden behind the disc.
    const halo = s.group().children[2]!;
    expect(halo.scale.x).toBeCloseTo(4 * 1.6, 5);
    avatars.dispose();
  });

  it('releases the avatars source again once nothing animates', async () => {
    stubDom();
    const s = stubScene();
    const avatars = new WorldAvatars(s.scene, () => s.anchor);
    await avatars.setLayer('residents', [
      { id: 'float', coordinate: ORIGIN, fallbackLabel: 'F', anchorHeight: 'roof', snapToBuilding: true, float: { amplitudeMeters: 0.4 } },
    ]);
    expect(s.isAnimating()).toBe(true);
    expect(s.isReleased()).toBe(false);
    avatars.removeLayer('residents');
    expect(s.isAnimating()).toBe(false);
    expect(s.isReleased()).toBe(true);
    avatars.dispose();
  });
});

describe('avatar textures (disc and frame are separate)', () => {
  it('draws the fallback label into the disc when there is no portrait', () => {
    stubDom();
    calls.length = 0;
    const canvas = drawAvatarDisc(null, 'luna', '#fc2a77', 256);
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(256);
    expect(calls).toContain('fillText');
    expect(calls).toContain('arc');
    expect(calls).not.toContain('drawImage');
  });

  it('clips a portrait into the disc and draws no label over it', () => {
    stubDom();
    calls.length = 0;
    drawAvatarDisc({} as CanvasImageSource, 'L', '#18ddd9', 256);
    expect(calls).toContain('drawImage');
    expect(calls).toContain('clip');
    expect(calls).not.toContain('fillText');
  });

  it('keeps the disc free of the border: the frame is its own texture', () => {
    stubDom();
    calls.length = 0;
    drawAvatarDisc({} as CanvasImageSource, '', '#fc2a77', 256);
    // The border must not compete with the portrait inside the same canvas —
    // that is what made a loaded portrait render without a border.
    expect(calls).not.toContain('stroke');
    expect(calls).not.toContain('moveTo');
  });

  it('draws the border as a filled ring plus the accent on the frame texture', () => {
    stubDom();
    calls.length = 0;
    drawAvatarFrame('#fc2a77', 256, false);
    // A hairline stroke disappears when the 256px texture is minified onto a
    // ~30px avatar; the border is a filled annulus plus an accent stroke.
    expect(calls.filter((k) => k === 'fill').length).toBeGreaterThanOrEqual(1);
    expect(calls).toContain('stroke');
    expect(calls).toContain('arc');
  });

  it('draws the pointer on the frame, so it survives a loaded portrait', () => {
    stubDom();
    calls.length = 0;
    drawAvatarFrame('#fc2a77', 256, true);
    // The pointer is a filled triangle: beginPath + moveTo/lineTo + fill.
    expect(calls).toContain('moveTo');
    expect(calls).toContain('lineTo');
    expect(calls).toContain('fill');
    // The frame texture is shared shape: no portrait is ever composited into it.
    expect(calls).not.toContain('drawImage');
  });

  it('places the disc and the pointer at the same geometry, so they line up', () => {
    const withPointer = avatarGeometry(256, true);
    const without = avatarGeometry(256, false);
    // Both textures compute their metrics from the same helper, which is what
    // keeps the ring centred on the disc it belongs to.
    expect(withPointer.r).toBeLessThan(without.r);
    expect(withPointer.cy).toBeLessThan(without.cy);
    expect(avatarGeometry(256, true)).toEqual(withPointer);
  });
});
