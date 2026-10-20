/** Roof-anchored labels for host-authored places, using Maprama's holo cards and collision rules. */
import type { LabelIcon, LngLat } from '@open-yescoin/maprama-protocol';
import type { SceneApi } from '../scene-api.js';
import { HoloLabels } from './holo.js';
import { ensureLabelStyles } from './dom-styles.js';
import { hudExclusions, type LabelEntry } from './index.js';

export interface BuildingLabelSpec {
  buildingId: string;
  title: string;
  subtitle?: string;
  icon?: LabelIcon;
  /** Identification labels are visible only at close zoom and lose collisions to named places. */
  identifier?: boolean;
}

export class BuildingLabelOverlay {
  private readonly layer: HTMLDivElement;
  private readonly holo: HoloLabels;
  private readonly offFrame: () => void;
  private readonly offWorld: () => void;
  private releaseAnimation: (() => void) | null = null;
  private specs: BuildingLabelSpec[] = [];
  private entries: LabelEntry[] = [];

  constructor(private readonly scene: SceneApi, private readonly onPress?: (buildingId: string, coordinate: LngLat) => void) {
    const doc = scene.container.ownerDocument;
    ensureLabelStyles(doc);
    this.layer = doc.createElement('div');
    this.layer.className = 'mpr-labels kindra-building-labels';
    scene.overlayLayer.appendChild(this.layer);
    this.holo = new HoloLabels(this.layer);
    this.offFrame = scene.onBeforeRender(() => this.update());
    this.offWorld = scene.onWorldLoad(() => this.rebuild());
  }

  set(specs: readonly BuildingLabelSpec[]): void {
    const next = specs.filter(spec => spec.title.trim()).map(spec => ({ ...spec }));
    this.specs = next;
    this.rebuild();
  }

  private rebuild(): void {
    const world = this.scene.world();
    if (!world) return;
    const byId = new Map(world.buildings.map(building => [building.id, building]));
    this.entries = this.specs.flatMap(spec => {
      const building = byId.get(spec.buildingId);
      if (!building) return [];
      const icon = spec.icon ?? 'store';
      return [{ id: `building:${spec.buildingId}`, kind: 'poi' as const, name: spec.title, subtitle: spec.subtitle, category: 'store' as const, lngLat: this.scene.toLngLat({ x: building.x, z: building.z }), x: building.x, z: building.z, pri: spec.identifier ? 5 : 1, icon, lift: spec.identifier ? 0.6 : 1, maxDistance: spec.identifier ? 70 : undefined }];
    });
    this.holo.build(this.entries, id => {
      const buildingId = id.slice('building:'.length);
      const top = this.scene.building(buildingId)?.top;
      if (top) this.onPress?.(buildingId, this.scene.toLngLat({ x: top.x, z: top.z }));
    });
    this.scene.requestRender();
  }

  private update(): void {
    const world = this.scene.world();
    if (!world) return;
    for (const entry of this.entries) {
      const top = this.scene.building(entry.id.slice('building:'.length))?.top;
      if (top) { entry.x = top.x; entry.z = top.z; entry.anchorY = top.y; }
    }
    const camera = this.scene.camera;
    this.layer.classList.toggle('night', this.scene.params().lights > 0.8);
    this.holo.update(camera, 'nameAndType', {}, hudExclusions(camera.width, camera.height, this.scene.ui(), camera.inset), world.buildingBaseY, performance.now(), this.scene.anchorHeightScale());
    if (this.holo.animating && !this.releaseAnimation) this.releaseAnimation = this.scene.addActiveSource('building-labels');
    else if (!this.holo.animating && this.releaseAnimation) { this.releaseAnimation(); this.releaseAnimation = null; }
  }

  dispose(): void {
    this.offFrame();
    this.offWorld();
    this.releaseAnimation?.();
    this.holo.clear();
    this.layer.remove();
  }
}
