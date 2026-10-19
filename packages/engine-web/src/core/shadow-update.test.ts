import { describe, expect, it } from 'vitest';
import { SHADOW_INERT_SOURCES, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE_MOBILE, ShadowUpdatePolicy, shadowMapSizeFor } from './shadow-update.js';
import { FrameScheduler } from './frame-scheduler.js';

const state = (over: Partial<Parameters<ShadowUpdatePolicy['next']>[0]> = {}) => ({
  enabled: true, x: 0, z: 0, dirX: 30, dirY: 30, dirZ: 24, extent: 48, far: 160, moving: false, ...over,
});

describe('ShadowUpdatePolicy', () => {
  it('draws the first frame, then keeps the map while nothing changes', () => {
    const p = new ShadowUpdatePolicy();
    expect(p.next(state())).toBe(true);
    expect(p.next(state())).toBe(false);
    expect(p.next(state())).toBe(false);
  });

  it('redraws when the shadow camera follows the map camera', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ x: 0.01 }))).toBe(true);
    expect(p.next(state({ x: 0.01 }))).toBe(false);
    expect(p.next(state({ x: 0.01, z: -4 }))).toBe(true);
  });

  it('does not redraw when the camera only rotates or zooms (the sun does not move)', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state({ x: 12, z: -3 }));
    // a rotation / a zoom that stays below the zoom-out threshold leaves sun and frustum alone
    expect(p.next(state({ x: 12, z: -3 }))).toBe(false);
  });

  it('redraws when the sun direction or the zoom-out frustum changes', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ dirY: 18 }))).toBe(true);
    expect(p.next(state({ dirY: 18 }))).toBe(false);
    expect(p.next(state({ dirY: 18, extent: 60 }))).toBe(true);
    expect(p.next(state({ dirY: 18, extent: 60 }))).toBe(false);
    expect(p.next(state({ dirY: 18, extent: 60, far: 200 }))).toBe(true);
  });

  it('redraws for explicit invalidation exactly once', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state())).toBe(false);
    p.invalidate();
    expect(p.next(state())).toBe(true);
    expect(p.next(state())).toBe(false);
  });

  it('keeps redrawing while something moves, and once more on the frame it stops', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ moving: true }))).toBe(true);
    expect(p.next(state({ moving: true }))).toBe(true);
    // the source is released inside the frame hooks, i.e. before the decision, while the motion
    // it applied is still being drawn: that frame must still refresh the map
    expect(p.next(state({ moving: false }))).toBe(true);
    expect(p.next(state({ moving: false }))).toBe(false);
  });

  it('never draws while shadows are off, and draws again when they come back', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ enabled: false }))).toBe(false);
    expect(p.next(state({ enabled: false, moving: true }))).toBe(false);
    expect(p.next(state())).toBe(true);
  });

  it('keeps a pending invalidation across frames without shadows', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state({ enabled: false }));
    p.invalidate();
    expect(p.next(state({ enabled: false }))).toBe(false);
    expect(p.next(state())).toBe(true);
  });
});

describe('active sources that matter for shadows', () => {
  it('treats DOM-only, event-only and viewer-only tags as inert', () => {
    const s = new FrameScheduler();
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
    // `camera` / `zoomOut` are inert because the shadow camera itself is
    // compared by `same()`; `camera:idle` and `infoCards` never touch the 3D
    // scene at all.
    for (const tag of ['labels', 'infoCards', 'camera:change', 'camera:idle', 'camera', 'zoomOut', 'avatars', 'buildings']) {
      expect(SHADOW_INERT_SOURCES.has(tag)).toBe(true);
      const release = s.addSource(tag);
      expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
      release();
    }
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
  });

  it('keeps counting a view transition as motion: it squashes the building shadow casters', () => {
    // `engine.ts` scales every building by `1 - view.t` during a 2D / 2.5D
    // transition without touching the shadow camera, so the depth map must be
    // allowed to refresh while `view` is held.
    expect(SHADOW_INERT_SOURCES.has('view')).toBe(false);
    const s = new FrameScheduler();
    const release = s.addSource('view');
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(true);
    release();
  });

  it('counts anything else as scene motion, including an unknown tag', () => {
    const s = new FrameScheduler();
    expect(SHADOW_INERT_SOURCES.has('building:shadow')).toBe(false);
    expect(SHADOW_INERT_SOURCES.has('traffic')).toBe(false);
    const chars = s.addSource('chars');
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(true);
    chars();
    // an unknown tag (a third-party addActiveSource) counts as motion
    const other = s.addSource('my-extension');
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(true);
    other();
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
  });
});

describe('shadowMapSizeFor', () => {
  it('halves the resolution on phones and tablets only', () => {
    expect(shadowMapSizeFor(undefined)).toBe(SHADOW_MAP_SIZE);
    expect(shadowMapSizeFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140 Safari/537.36')).toBe(SHADOW_MAP_SIZE);
    expect(shadowMapSizeFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148')).toBe(SHADOW_MAP_SIZE_MOBILE);
    expect(shadowMapSizeFor('Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/140 Mobile Safari/537.36')).toBe(SHADOW_MAP_SIZE_MOBILE);
    expect(shadowMapSizeFor('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Safari/604.1')).toBe(SHADOW_MAP_SIZE_MOBILE);
  });
});
