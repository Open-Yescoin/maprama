import { decodeTile, type MtilTile } from '@open-yescoin/maprama-protocol';
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
import { encodeTile } from '../../../protocol/src/__fixtures__/tile.js';
import { assembleTileWorld } from '../tiles/assemble.js';
import { TileFrame, tileOf } from '../tiles/mercator.js';
import { MaterialFactory } from '../theme/materials.js';
import { renderParamsFor } from '../theme/params.js';
import type { TextureSet } from '../theme/textures.js';
import type { WorldModel } from '../world/model.js';
import { BuildingRenderer, sameShape } from './buildings.js';
import type { RenderContext } from './parts.js';

const SEOUL = { lng: 127.056, lat: 37.5445 };
const EXTENT = 8192;
const at = tileOf(SEOUL.lng, SEOUL.lat, 15);

/**
 * `ids` as 24 m squares on a grid. Position and height come from the **id**,
 * not from the position in the list, so a building is the same building
 * whichever other tiles happen to be in the world — which is what the tile
 * archive guarantees and what these tests are about.
 */
const tileWith = (ids: readonly string[]): MtilTile =>
  decodeTile(
    encodeTile({
      extent: EXTENT,
      buffer: 256,
      layers: {
        buildings: ids.map((id) => {
          const k = id.charCodeAt(0) % 16;
          const x = 500 + (k % 4) * 700, y = 500 + Math.floor(k / 4) * 700;
          return { id, heightDm: 100 + k * 30, footprint: [[x, y], [x + 300, y], [x + 300, y + 300], [x, y + 300]] as [number, number][] };
        }),
      },
    }),
  );

/** A world of the given building ids, anchored at `anchor` (a different anchor is a re-base). */
function world(ids: readonly string[], anchor = SEOUL, dx = 0): WorldModel {
  return assembleTileWorld([{ z: 15, x: at.x + dx, y: at.y, tile: tileWith(ids) }], {
    frame: new TileFrame(anchor, SEOUL.lat, 8),
    attribution: [],
    name: 'x',
  });
}

/**
 * A render context with real render params and materials. The textures are only
 * ever read for material options and facade UV steps, and three takes
 * `undefined` for a map, so a stub with the facade table filled in is enough to
 * build the whole scene graph without a canvas.
 */
function context(w: WorldModel): RenderContext {
  const facade = new Proxy({}, { get: () => ({ tex: undefined, lit: undefined, U: 1, V: 1 }) }) as TextureSet['facade'];
  return { params: renderParamsFor({ base: 'urban', timeOfDay: 'day' }), mats: new MaterialFactory(), tex: { facade } as TextureSet, world: w };
}

/**
 * Every mesh of every building, by building id, **by reference** — reuse means
 * the very same objects come back, not equal-looking ones.
 */
function meshes(r: BuildingRenderer): Map<string, object[]> {
  const out = new Map<string, object[]>();
  for (const g of r.group.children) {
    const id = g.userData.buildingId as string;
    const list: object[] = [];
    g.traverse((o) => { if (o !== g) list.push(o); });
    out.set(id, list);
  }
  return out;
}

/** Asserts the two lists are the same objects in the same order. */
function sameObjects(a: object[] | undefined, b: object[] | undefined): void {
  expect(a).toBeDefined();
  expect(a).toHaveLength(b?.length ?? -1);
  for (let i = 0; i < (a?.length ?? 0); i++) expect(a![i]).toBe(b![i]);
}

describe('sameShape', () => {
  const a = world(['a', 'b']).buildings;

  it('is true for the same tile assembled around a different anchor', () => {
    const b = world(['a', 'b'], { lng: SEOUL.lng + 0.04, lat: SEOUL.lat - 0.03 }).buildings;
    expect(a).toHaveLength(2);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.x).not.toBe(b[i]!.x);
      expect(sameShape(a[i]!, b[i]!)).toBe(true);
    }
  });

  it('is false when the building itself differs', () => {
    const taller = { ...a[0]!, h: a[0]!.h + 1 };
    expect(sameShape(a[0]!, taller)).toBe(false);
    const reshaped = { ...a[0]!, footprint: a[0]!.footprint.map(([x, z]) => [x * 1.5, z] as [number, number]) };
    expect(sameShape(a[0]!, reshaped)).toBe(false);
    expect(sameShape(a[0]!, a[1]!)).toBe(false);
  });
});

describe('BuildingRenderer incremental rebuilds', () => {
  it('keeps the meshes of a building that only moved, and moves its group', () => {
    const r = new BuildingRenderer();
    const w0 = world(['a', 'b', 'c']);
    const ctx0 = context(w0);
    r.build(ctx0);
    const before = meshes(r);

    // A re-base: the same tile, a different anchor.
    const w1 = world(['a', 'b', 'c'], { lng: SEOUL.lng + 0.05, lat: SEOUL.lat });
    r.build({ ...ctx0, world: w1 }, true);
    const after = meshes(r);

    expect([...after.keys()].sort()).toEqual(['a', 'b', 'c']);
    for (const id of after.keys()) sameObjects(after.get(id), before.get(id));
    const moved = r.group.children.find((g) => g.userData.buildingId === 'a')!;
    expect(moved.position.x).toBeCloseTo(w1.buildings.find((b) => b.id === 'a')!.x, 9);
  });

  it('builds only what arrived and drops only what left', () => {
    const r = new BuildingRenderer();
    const ctx = context(world(['a', 'b', 'c']));
    r.build(ctx);
    const before = meshes(r);

    r.build({ ...ctx, world: world(['b', 'c', 'd']) }, true);
    const after = meshes(r);

    expect([...after.keys()].sort()).toEqual(['b', 'c', 'd']);
    sameObjects(after.get('b'), before.get('b'));
    sameObjects(after.get('c'), before.get('c'));
    expect(after.get('d')![0]).not.toBe(before.get('a')![0]);
    expect(r.has('a')).toBe(false);
  });

  it('produces the same scene graph as a rebuild from nothing', () => {
    const shape = (r: BuildingRenderer): string[] =>
      [...r.group.children]
        .map((g) => `${g.userData.buildingId as string}@${g.position.x.toFixed(6)},${g.position.z.toFixed(6)}:${countMeshes(g)}`)
        .sort();

    const incremental = new BuildingRenderer();
    const ctx = context(world(['a', 'b', 'c']));
    incremental.build(ctx);
    const next = world(['b', 'c', 'd']);
    incremental.build({ ...ctx, world: next }, true);

    const fresh = new BuildingRenderer();
    fresh.build({ ...ctx, world: next });

    expect(shape(incremental)).toEqual(shape(fresh));
  });

  it('refuses to reuse across a theme change', () => {
    const r = new BuildingRenderer();
    const w = world(['a', 'b']);
    r.build(context(w));
    const before = meshes(r);
    // A new params/materials generation: everything must be built again.
    r.build(context(w), true);
    expect(meshes(r).get('a')![0]).not.toBe(before.get('a')![0]);
  });
});

function countMeshes(o: { traverse(cb: (child: unknown) => void): void }): number {
  let n = 0;
  o.traverse(() => { n++; });
  return n;
}

describe('building shadow motion', () => {
  it('keeps captured glow animated without redrawing depth, but tracks bounce and height changes', () => {
    const r = new BuildingRenderer();
    r.build(context(world(['a'])));
    const id = r.ids()[0]!;
    r.setStyle(id, { state: 'captured' });
    for (let i = 0; i < 30; i++) r.step(1 / 60, i / 60, 1, false);
    expect(r.animating).toBe(true);
    expect(r.shadowAnimating).toBe(false);
    r.bounce(id);
    r.step(1 / 60, 1, 1, false);
    expect(r.shadowAnimating).toBe(true);
    for (let i = 0; i < 30; i++) r.step(1 / 60, 1 + i / 60, 1, false);
    expect(r.shadowAnimating).toBe(false);
    r.step(0, 2, 0.6, false);
    expect(r.shadowAnimating).toBe(true);
    r.step(0, 2, 0.6, false);
    expect(r.shadowAnimating).toBe(false);
    r.dispose();
  });

  it('still marks a rotating landmark as a moving shadow caster', () => {
    const w = world(['a']);
    w.buildings[0]!.landmark = true;
    const r = new BuildingRenderer();
    r.build(context(w));
    r.step(1 / 60, 1, 1, false);
    expect(r.animating).toBe(true);
    expect(r.shadowAnimating).toBe(true);
    r.step(1 / 60, 2, 1, true);
    expect(r.shadowAnimating).toBe(false);
    r.dispose();
  });
});

describe('custom model distance', () => {
  it('omits the native-lot black contact decal for imported models', async () => {
    const w = world(['a']);
    const renderer = new BuildingRenderer();
    renderer.build(context(w));
    const group = renderer.group.children.find(child => child.userData.buildingId === 'a')!;
    expect(group.children.some(child => child.renderOrder === 1)).toBe(true);
    renderer.loadModel = async () => new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    renderer.setStyle('a', { replaceModel: { uri: 'https://example.com/building.glb' } });
    expect(group.children.some(child => child.renderOrder === 1)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(group.children.some(child => child.renderOrder === 1)).toBe(false);
    renderer.dispose();
  });

  it('fits imported models to independent width, depth and height targets', async () => {
    const w = world(['a']);
    const renderer = new BuildingRenderer();
    renderer.build(context(w));
    renderer.loadModel = async () => new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    renderer.setStyle('a', { replaceModel: { uri: 'https://example.com/building.glb', widthMeters: 12, depthMeters: 8, heightMeters: 18, scale: 2 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const group = renderer.group.children.find(child => child.userData.buildingId === 'a')!;
    const model = group.children.at(-2)!;
    expect(model.scale.x).toBeCloseTo(2);
    expect(model.scale.z).toBeCloseTo(2);
    expect(model.scale.y).toBeCloseTo(18 / w.unitMeters);
    renderer.dispose();
  });

  it('keeps a loaded GLB visible while editing rotation, height and static footprint', async () => {
    const w = world(['a']);
    const ctx = context(w);
    const renderer = new BuildingRenderer();
    renderer.build(ctx);
    let loads = 0;
    renderer.loadModel = async () => { loads++; return new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial()); };
    const uri = 'https://example.com/building.glb';
    renderer.setStyle('a', { replaceModel: { uri, heightMeters: 12 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const firstGroup = renderer.group.children.find(child => child.userData.buildingId === 'a')!;
    const model = firstGroup.children.at(-2)! as Mesh;
    let geometryDisposed = false;
    model.geometry.addEventListener('dispose', () => { geometryDisposed = true; });
    renderer.setStyle('a', { replaceModel: { uri, rotationDeg: 90, heightMeters: 24 } });
    expect(firstGroup.children.at(-2)).toBe(model);
    expect(model.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(model.scale.y).toBeCloseTo(24 / w.unitMeters / 2);
    expect((firstGroup.children.at(-1) as Mesh).rotation.y).toBeCloseTo(Math.PI / 2);
    expect(geometryDisposed).toBe(false);
    const changedWorld = { ...w, buildings: [{ ...w.buildings[0]!, h: w.buildings[0]!.h * 1.5, rect: w.buildings[0]!.rect ? { ...w.buildings[0]!.rect, w: w.buildings[0]!.rect!.w * 1.2 } : null }] };
    renderer.build({ ...ctx, world: changedWorld }, true);
    const rebuilt = renderer.group.children.find(child => child.userData.buildingId === 'a')!;
    expect(rebuilt.children.at(-2)).toBe(model);
    expect(renderer.info('a')?.modelLoadState).toBe('loaded');
    expect(loads).toBe(1);
    expect(geometryDisposed).toBe(false);
    renderer.dispose();
  });

  it('keeps the distance proxy visible when a far model is resized', async () => {
    const w = world(['a']);
    const renderer = new BuildingRenderer();
    renderer.build(context(w));
    renderer.loadModel = async () => new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    const uri = 'https://example.com/building.glb';
    renderer.setStyle('a', { replaceModel: { uri, heightMeters: 12 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    renderer.step(0, 0, 1, false, 5_000);
    renderer.setStyle('a', { replaceModel: { uri, heightMeters: 24, rotationDeg: 90 } });
    const group = renderer.group.children.find(child => child.userData.buildingId === 'a')!;
    expect(group.children.at(-2)!.visible).toBe(false);
    expect(group.children.at(-1)!.visible).toBe(true);
    renderer.dispose();
  });

  it('changes native visual width, depth, height and yaw without changing source geometry', () => {
    const w = world(['a']);
    const renderer = new BuildingRenderer();
    renderer.build(context(w));
    const group = renderer.group.children.find(child => child.userData.buildingId === 'a')!;
    renderer.setStyle('a', { widthScale: 1.8, depthScale: 0.7, heightScale: 1.5, rotationDeg: 90 });
    renderer.step(0, 0, 1, true, 150);
    expect(group.scale.x).toBeCloseTo(1.8);
    expect(group.scale.z).toBeCloseTo(0.7);
    expect(group.scale.y).toBeCloseTo(1.5);
    expect(group.rotation.y).toBeCloseTo(w.buildings[0]!.yaw + Math.PI / 2);
    expect(w.buildings[0]!.footprint).toHaveLength(4);
    renderer.setStyle('a', null);
    expect(group.scale.x).toBe(1);
    expect(group.scale.z).toBe(1);
    renderer.dispose();
  });

  it('keeps the GLB at city overview distance and reserves the proxy for extreme distance', async () => {
    const w = world(['a']);
    const renderer = new BuildingRenderer();
    renderer.build(context(w));
    renderer.loadModel = async () => new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    expect(renderer.setStyle('a', { replaceModel: { uri: 'https://example.com/building.glb' } })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(renderer.info('a')?.modelLoadState).toBe('loaded');
    const group = renderer.group.children.find(child => child.userData.buildingId === 'a')!;
    const model = group.children.at(-2)!;
    const proxy = group.children.at(-1)!;
    renderer.step(0, 0, 1, false, 900);
    expect(model.visible).toBe(true);
    expect(proxy.visible).toBe(false);
    renderer.step(0, 0, 1, false, 5_000);
    expect(model.visible).toBe(false);
    expect(proxy.visible).toBe(true);
    expect(renderer.shadowAnimating).toBe(true);
    renderer.step(0, 0, 1, false, 150);
    expect(model.visible).toBe(true);
    expect(proxy.visible).toBe(false);
    renderer.dispose();
  });
});
