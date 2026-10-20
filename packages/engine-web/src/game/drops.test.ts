import type { DropSpec } from '@open-yescoin/maprama-protocol';
import { validateEngineEvent } from '@open-yescoin/maprama-protocol';
import { MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneApi } from '../scene-api.js';
import { DropCollector, DropVisuals, MAX_ISSUED_COLLECT_IDS, randomCollectId, type Collector, type DropState } from './drops.js';

const ll = (p: { x: number; z: number }) => ({ lng: 127 + p.x * 1e-4, lat: 37.5 - p.z * 1e-4 });
const drop = (id: string, type: DropSpec['type'] = 'coin'): DropSpec => ({ id, type, coordinate: { lng: 0, lat: 0 } });
const me: Collector = { id: 'me', x: 0, z: 0, isPlayer: true };
const npc: Collector = { id: 'npc', x: 0, z: 0, isPlayer: false };

describe('DropCollector', () => {
  it('collects a drop once, within the radius, with a valid event', () => {
    const c = new DropCollector();
    c.setLayer('coins', [{ spec: drop('a'), x: 1, z: 0 }, { spec: drop('far'), x: 10, z: 0 }], 2);
    const first = c.check([me], ll);
    expect(first).toHaveLength(1);
    const e = first[0]!.event;
    expect(e).toMatchObject({ type: 'drop:collect', layerId: 'coins', dropId: 'a', characterId: 'me' });
    expect(validateEngineEvent(e)).toEqual({ ok: true });
    expect(e.coordinate).toEqual(ll(me));
    expect(c.check([me], ll)).toHaveLength(0);
    expect(c.check([{ ...me, x: 10 }], ll).map((r) => r.event.dropId)).toEqual(['far']);
    expect(c.check([{ ...me, x: 10 }], ll)).toHaveLength(0);
  });

  it('uses the player by default, collectorIds when given, nobody for []', () => {
    const c = new DropCollector();
    c.setLayer('default', [{ spec: drop('d'), x: 0, z: 0 }], 1);
    expect(c.check([npc], ll)).toHaveLength(0);
    expect(c.check([npc, me], ll).map((r) => r.event.characterId)).toEqual(['me']);
    c.setLayer('npcOnly', [{ spec: drop('n'), x: 0, z: 0 }], 1, ['npc']);
    expect(c.check([me], ll)).toHaveLength(0);
    expect(c.check([me, npc], ll).map((r) => r.event.characterId)).toEqual(['npc']);
    c.setLayer('nobody', [{ spec: drop('x'), x: 0, z: 0 }], 1, []);
    expect(c.check([me, npc], ll)).toHaveLength(0);
  });

  it('is once per drop per collector across layer re-sends', () => {
    const c = new DropCollector();
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }], 1, ['me', 'npc']);
    expect(c.check([me], ll)).toHaveLength(1);
    // host re-sends the same drop: it is shown again…
    const diff = c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }], 1, ['me', 'npc']);
    expect(diff.added.map((d) => d.spec.id)).toEqual(['a']);
    // …but the same collector cannot collect it twice; another collector can
    expect(c.check([me], ll)).toHaveLength(0);
    expect(c.check([me, npc], ll).map((r) => r.event.characterId)).toEqual(['npc']);
  });

  it('issues unique, UUID-formatted collectIds', () => {
    const c = new DropCollector();
    const drops = Array.from({ length: 300 }, (_, i) => ({ spec: drop(`d${i}`), x: 0, z: 0 }));
    c.setLayer('many', drops, 1);
    const ids = c.check([me], ll).map((r) => r.event.collectId);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomCollectId()).not.toBe(randomCollectId());
  });

  it('never reuses an id even if the generator repeats', () => {
    let n = 0;
    const seq = ['x', 'x', 'y'];
    const c = new DropCollector(() => seq[Math.min(n++, seq.length - 1)]!);
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }, { spec: drop('b'), x: 0, z: 0 }], 1);
    expect(c.check([me], ll).map((r) => r.event.collectId)).toEqual(['x', 'y']);
  });

  it('keeps a drop whose id stays in the spec uncollectable by the same collector', () => {
    const c = new DropCollector();
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }, { spec: drop('b'), x: 5, z: 5 }], 1);
    expect(c.check([me], ll).map((r) => r.event.dropId)).toEqual(['a']);
    // the host keeps sending the collected id (with other changes around it)
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }, { spec: drop('b'), x: 6, z: 5 }], 1);
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }], 1);
    expect(c.check([me], ll)).toHaveLength(0);
  });

  it('lets the same collector collect again after the id was removed from the spec and added back', () => {
    const c = new DropCollector();
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }], 1);
    const first = c.check([me], ll);
    expect(first).toHaveLength(1);
    // host hides the drop (e.g. while verifying), then restores it after a rejection
    expect(c.setLayer('l', [], 1).removed).toHaveLength(0);
    expect(c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }], 1).added.map((d) => d.spec.id)).toEqual(['a']);
    const again = c.check([me], ll);
    expect(again.map((r) => [r.event.dropId, r.event.characterId])).toEqual([['a', 'me']]);
    expect(again[0]!.event.collectId).not.toBe(first[0]!.event.collectId);
    expect(c.check([me], ll)).toHaveLength(0);
  });

  it('forgets a removed layer\'s collections, but not other layers\'', () => {
    const c = new DropCollector();
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }], 1);
    c.setLayer('m', [{ spec: drop('a'), x: 0, z: 0 }], 1);
    expect(c.check([me], ll)).toHaveLength(2);
    c.removeLayer('l');
    c.setLayer('l', [{ spec: drop('a'), x: 0, z: 0 }], 1);
    c.setLayer('m', [{ spec: drop('a'), x: 0, z: 0 }], 1);
    expect(c.check([me], ll).map((r) => r.event.layerId)).toEqual(['l']);
  });

  it(`remembers only the last ${MAX_ISSUED_COLLECT_IDS} collectIds`, () => {
    const ids: string[] = [];
    let n = 0;
    let repeatFirst = false;
    const c = new DropCollector(() => (repeatFirst ? 'id-0' : `id-${n++}`));
    const total = MAX_ISSUED_COLLECT_IDS + 1;
    c.setLayer('many', Array.from({ length: total }, (_, i) => ({ spec: drop(`d${i}`), x: 0, z: 0 })), 1);
    for (const r of c.check([me], ll)) ids.push(r.event.collectId);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    // 'id-0' is the oldest and was evicted, so the generator may return it again
    repeatFirst = true;
    c.setLayer('one', [{ spec: drop('x'), x: 0, z: 0 }], 1);
    expect(c.check([me], ll).map((r) => r.event.collectId)).toEqual(['id-0']);
    // an id still remembered is never reused: a generator stuck on one fails instead
    const stuck = new DropCollector(() => 'dup');
    stuck.setLayer('l', [{ spec: drop('p'), x: 0, z: 0 }, { spec: drop('q'), x: 0, z: 0 }], 1);
    expect(() => stuck.check([me], ll)).toThrow(/duplicates/);
  });

  it('diffs layer replacements and removals', () => {
    const c = new DropCollector();
    c.setLayer('l', [{ spec: drop('keep'), x: 0, z: 0 }, { spec: drop('gone'), x: 5, z: 5 }, { spec: drop('swap'), x: 9, z: 9 }], 1);
    const d = c.setLayer('l', [{ spec: drop('keep'), x: 1, z: 0 }, { spec: drop('swap', 'cd'), x: 9, z: 9 }, { spec: drop('new'), x: 3, z: 3 }], 1);
    expect(d.moved.map((s) => s.spec.id)).toEqual(['keep']);
    expect(d.added.map((s) => s.spec.id).sort()).toEqual(['new', 'swap']);
    expect(d.removed.map((s) => s.spec.id).sort()).toEqual(['gone', 'swap']);
    expect(c.removeLayer('l').map((s) => s.spec.id).sort()).toEqual(['keep', 'new', 'swap']);
    expect(c.check([me], ll)).toHaveLength(0);
  });
});

/**
 * `DropVisuals.step` runs against a stub scene: the assertions are about which
 * items survive a frame, not about pixels.
 */
function stubVisualScene(): SceneApi {
  const doc = { getElementById: () => ({}) } as unknown as Document;
  return {
    container: { addEventListener: () => {}, removeEventListener: () => {}, ownerDocument: doc },
    overlayLayer: { ownerDocument: doc },
    materials: { make: () => new MeshStandardMaterial(), ink: new MeshStandardMaterial() },
    params: () => ({ outline: false }),
    reduceMotion: false,
    anchorHeightScale: () => 1,
    camera: { worldToScreen: () => ({ x: 0, y: 0, visible: false }) },
  } as unknown as SceneApi;
}

const item = (id: string, x: number): DropState => ({ layerId: 'l', spec: drop(id), x, z: 0, collected: false });

describe('DropVisuals.step', () => {
  it('removes every item that finished its pop in one frame and keeps the rest', () => {
    const visuals = new DropVisuals(stubVisualScene(), { onModelError: () => {} });
    visuals.add(item('a', 1), 0);
    visuals.add(item('b', 2), 0);
    visuals.add(item('c', 3), 0);
    visuals.collect(item('a', 1));
    visuals.collect(item('b', 2));
    // One frame longer than the 0.45 s pop removes a and b; c, stepped after both, must survive.
    visuals.step(1, 0);
    expect(visuals.count).toBe(1);
    expect(visuals.group.children).toHaveLength(1);
    expect(visuals.group.children[0]!.position.x).toBe(3);
    visuals.dispose();
  });

  it('steps the items after a popped one before removing it', () => {
    const visuals = new DropVisuals(stubVisualScene(), { onModelError: () => {} });
    visuals.add(item('pop', 1), 0);
    visuals.add(item('live', 2), 0);
    const live = visuals.group.children[1]!;
    visuals.collect(item('pop', 1));
    // The pop is not finished: nothing is removed and `live` still spins this frame.
    visuals.step(0.1, 0);
    expect(visuals.count).toBe(2);
    expect(live.children[0]!.rotation.y).toBeCloseTo(0.22, 5);
    // The next frame finishes the pop: only that item goes, and the survivor stays put.
    visuals.step(1, 0);
    expect(visuals.count).toBe(1);
    expect(visuals.group.children[0]).toBe(live);
    visuals.dispose();
  });
});
