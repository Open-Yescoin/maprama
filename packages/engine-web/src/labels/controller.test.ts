import type { LabelsSpec } from '@open-yescoin/maprama-protocol';
import { describe, expect, it, vi } from 'vitest';
import { projectionFor } from '../engine/requests.js';
import type { SceneApi } from '../scene-api.js';
import { buildTownWorld } from '../world/town.js';
import { LabelController } from './controller.js';

const render = vi.hoisted(() => ({ holo: { build: vi.fn(), update: vi.fn(), hide: vi.fn(), clear: vi.fn(), invalidate: vi.fn(), animating: false }, dom: { build: vi.fn(), update: vi.fn(), hide: vi.fn(), clear: vi.fn(), invalidate: vi.fn() } }));
vi.mock('./holo.js', () => ({ HoloLabels: class { constructor() { return render.holo; } } }));
vi.mock('./dom-styles.js', () => ({ ensureLabelStyles: vi.fn(), DomLabels: class { constructor() { return render.dom; } } }));

function fixture() {
  vi.clearAllMocks();
  const world = buildTownWorld(0), proj = projectionFor(world), building = world.buildings[0]!;
  const top = { x: building.x, y: 12, z: building.z };
  let labels: LabelsSpec = {};
  const layer = { classList: { toggle: vi.fn() }, remove: vi.fn() };
  const scene = {
    overlayLayer: { ownerDocument: { createElement: () => layer }, appendChild: vi.fn() },
    labels: () => labels, params: () => ({ lights: 0 }), ui: () => ({}), zoomOutFactor: () => 0,
    camera: { width: 900, height: 600 }, anchorHeightScale: () => 1,
    toWorld: proj.toWorld, toLngLat: proj.toLngLat,
    building: (id: string) => id === building.id ? { top } : undefined,
    emit: vi.fn(),
  };
  const controller = new LabelController(scene as unknown as SceneApi);
  controller.worldChanged(world, proj);
  const set = (next: LabelsSpec) => { labels = next; controller.settingsChanged(); };
  return { scene, controller, set, building, top, world, proj };
}

describe('one native label controller', () => {
  it('merges authored buildings and a POI into one index, renderer and collision pass', () => {
    const f = fixture(), poi = f.world.pois[0]!;
    const total = f.controller.entries.length;
    f.set({ includeBase: false, entries: [{ id: `building:${f.building.id}`, buildingId: f.building.id, title: 'Lounge' }, { id: `poi:${poi.id}`, coordinate: f.proj.toLngLat(poi), title: 'Park', icon: 'park' }] });
    expect(f.controller.entries).toHaveLength(total + 1);
    expect(f.controller.entries.filter(e => e.id === `poi:${poi.id}`)).toHaveLength(1);
    const reserved = [{ x: 25, y: 35, hw: 30, hh: 15 }];
    f.controller.update({}, {}, 0.2, 0, reserved);
    expect(f.scene.overlayLayer.appendChild).toHaveBeenCalledTimes(1);
    const [entries, press] = render.holo.build.mock.lastCall!;
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['Park', 'Lounge']);
    expect(entries.find((e: { name: string }) => e.name === 'Lounge').anchorY).toBe(12);
    expect(render.holo.update.mock.lastCall![3]).toContain(reserved[0]);
    press(`poi:${poi.id}`);
    expect(f.scene.emit).toHaveBeenLastCalledWith({ type: 'label:press', labelId: `poi:${poi.id}`, coordinate: f.proj.toLngLat(poi) });
    f.top.x += 2;
    f.controller.update({}, {}, 0.2, 1);
    press(`building:${f.building.id}`);
    expect(f.scene.emit).toHaveBeenLastCalledWith({ type: 'label:press', labelId: `building:${f.building.id}`, buildingId: f.building.id, coordinate: f.proj.toLngLat(f.top) });
  });

  it('honors enabled, style and custom text for authored and base labels together', () => {
    const f = fixture(), entries = [{ id: 'building:one', buildingId: f.building.id, title: 'Cafe' }];
    f.set({ enabled: false, entries });
    f.controller.update({}, {}, 0.2, 0);
    expect(render.holo.build).not.toHaveBeenCalled();
    f.set({ enabled: true, includeBase: false, style: 'minimal', content: 'custom', entries });
    const content = { 'building:one': { title: 'Coffee' } };
    f.controller.update(content, {}, 0.2, 40);
    expect(render.dom.build.mock.lastCall![0]).toHaveLength(1);
    expect(render.dom.update.mock.lastCall![3]).toBe(content);
    render.dom.build.mock.lastCall![1]('building:one');
    expect(f.scene.emit.mock.lastCall![0]).toMatchObject({ type: 'label:press', buildingId: f.building.id });
    f.set({ enabled: false, entries });
    f.controller.update({}, {}, 0.2, 80);
    expect(render.dom.hide).toHaveBeenCalled();
  });

  it('restores base labels on removal and avoids rebuilding unchanged entries', () => {
    const f = fixture(), base = f.controller.entries.map(e => e.name), poi = f.world.pois[0]!;
    const settings: LabelsSpec = { entries: [{ id: `poi:${poi.id}`, coordinate: f.proj.toLngLat(poi), title: 'New name' }] };
    f.set(settings);
    f.controller.update({}, {}, 0.2, 0);
    f.set(structuredClone(settings));
    f.controller.update({}, {}, 0.2, 1);
    expect(render.holo.build).toHaveBeenCalledTimes(1);
    f.set({ entries: [] });
    expect(f.controller.entries.map(e => e.name)).toEqual(base);
    f.controller.dispose();
    expect(render.holo.clear).toHaveBeenCalledOnce();
  });
});
