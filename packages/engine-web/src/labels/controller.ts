/**
 * Label controller: owns the label index of the loaded world and drives the
 * active label style (`app` / `minimal` / `clean` / `sticker` DOM labels,
 * `holo` floating cards, `ground` / `sign` 3D labels) from `LabelsSpec`, the
 * host's custom content and the camera.
 *
 * Defaults when a `LabelsSpec` field is absent: labels enabled, style
 * `holo`, icon tiles `auto`, content `nameAndType`.
 *
 * @module
 */

import type { LabelContent, LabelInfo, LabelsSpec, LabelStyle, MapUiSpec, Projection } from '@open-yescoin/maprama-protocol';
import type { SceneApi } from '../scene-api.js';
import type { WorldModel } from '../world/model.js';
import { DomLabels, ensureLabelStyles } from './dom-styles.js';
import { HoloLabels } from './holo.js';
import { buildLabelEntries, hudExclusions, iconTileFor, toLabelInfo, type Box, type DomLabelStyle, type LabelEntry } from './index.js';
import { WorldLabels3D } from './world3d.js';

export const DEFAULT_LABEL_STYLE: LabelStyle = 'holo';

/** Resolved label settings. */
export function resolveLabels(spec: LabelsSpec): Required<Pick<LabelsSpec, 'enabled' | 'style' | 'icons' | 'content'>> {
  return { enabled: spec.enabled ?? true, style: spec.style ?? DEFAULT_LABEL_STYLE, icons: spec.icons ?? 'auto', content: spec.content ?? 'nameAndType' };
}

const DOM_STYLES: readonly LabelStyle[] = ['app', 'minimal', 'clean', 'sticker'];

export class LabelController {
  entries: LabelEntry[] = [];
  private world: WorldModel | null = null;
  private baseEntries: LabelEntry[] = [];
  private entrySettings = '';
  private indexVersion = 0;
  private renderEntries: LabelEntry[] = [];
  private layer: HTMLDivElement | null = null;
  private dom: DomLabels | null = null;
  private holo: HoloLabels | null = null;
  private world3d: WorldLabels3D | null = null;
  private domBuilt = false;
  private holoBuilt = false;
  private contentVersion = 0;
  private lastStyle = '';
  private lastIndexJson = '';

  constructor(private readonly scene: SceneApi) {}

  /** The DOM layer labels and name tags are drawn into (created on demand). */
  domLayer(): HTMLDivElement {
    if (!this.layer) {
      const doc = this.scene.overlayLayer.ownerDocument;
      ensureLabelStyles(doc);
      this.layer = doc.createElement('div');
      this.layer.className = 'mpr-labels';
      this.scene.overlayLayer.appendChild(this.layer);
    }
    return this.layer;
  }

  /** Rebuilds the index for a world; returns the `labelsIndex` payload when it changed (always on a new world). */
  worldChanged(world: WorldModel, proj: Projection): LabelInfo[] {
    this.world = world;
    this.baseEntries = buildLabelEntries(world, proj);
    this.entrySettings = '';
    this.settingsChanged();
    const infos = this.entries.map(toLabelInfo);
    this.lastIndexJson = JSON.stringify(infos);
    return infos;
  }

  /** Merge host content into the same index and render passes as base labels. */
  settingsChanged(force = false): void {
    if (!this.world) return;
    const spec = this.scene.labels();
    const key = JSON.stringify([spec.includeBase ?? true, spec.entries ?? []]);
    if (!force && key === this.entrySettings) return;
    this.entrySettings = key;
    const entries = new Map(this.baseEntries.map(entry => [entry.id, entry]));
    for (const label of spec.entries ?? []) {
      const building = label.buildingId ? this.world.buildings.find(item => item.id === label.buildingId) : undefined;
      const anchor = building ?? (label.coordinate ? this.scene.toWorld(label.coordinate) : undefined);
      if (!anchor) continue;
      entries.set(label.id, { id: label.id, kind: 'poi', name: label.title, subtitle: label.subtitle, icon: label.icon ?? 'store', lngLat: this.scene.toLngLat(anchor), x: anchor.x, z: anchor.z, pri: label.priority ?? 1, maxDistance: label.maxDistance, buildingId: label.buildingId, authored: true });
    }
    this.entries = [...entries.values()];
    this.renderEntries = this.entries.filter(entry => spec.includeBase !== false || entry.authored);
    this.indexVersion++;
    this.domBuilt = this.holoBuilt = false;
    this.world3d?.clear();
  }

  private press = (id: string): void => {
    const entry = this.entries.find(item => item.id === id);
    if (entry) this.scene.emit({ type: 'label:press', labelId: id, coordinate: this.scene.toLngLat(entry), ...(entry.buildingId ? { buildingId: entry.buildingId } : {}) });
  };

  /** Index payload if it differs from the last reported one (`null` otherwise). */
  indexIfChanged(): LabelInfo[] | null {
    const infos = this.entries.map(toLabelInfo);
    const json = JSON.stringify(infos);
    if (json === this.lastIndexJson) return null;
    this.lastIndexJson = json;
    return infos;
  }

  contentChanged(): void {
    this.contentVersion++;
    this.dom?.invalidate();
    this.holo?.invalidate();
  }

  themeChanged(): void {
    this.dom?.invalidate();
    if (this.world3d) this.world3d.built = '';
  }

  /**
   * Per-frame update after the camera moved. `reserved` holds boxes already
   * taken by earlier passes (the marker layers, which are placed first), so
   * labels never cover a marker.
   */
  update(content: Readonly<Record<string, LabelContent>>, ui: MapUiSpec, groundY: number, now: number, reserved: readonly Box[] = []): void {
    const world = this.world;
    if (!world) return;
    const spec = resolveLabels(this.scene.labels());
    const params = this.scene.params();
    const night = params.lights > 0.8;
    const cam = this.scene.camera;
    const visibleEntries = this.renderEntries;
    for (const entry of visibleEntries) {
      const top = entry.buildingId ? this.scene.building(entry.buildingId)?.top : undefined;
      if (top) { entry.x = top.x; entry.z = top.z; entry.anchorY = top.y; entry.lngLat = this.scene.toLngLat(top); }
    }
    const style = spec.enabled ? spec.style : null;
    const layer = this.domLayer();
    if (this.lastStyle !== `${style}`) {
      this.lastStyle = `${style}`;
      for (const s of ['minimal', 'sticker', 'clean']) layer.classList.toggle(`ls-${s}`, style === s);
      this.dom?.invalidate();
    }
    layer.classList.toggle('night', night);
    const tile = iconTileFor(spec.icons, night);
    for (const t of ['white', 'black', 'color']) layer.classList.toggle(`hi-${t}`, tile === t);
    const hud = hudExclusions(cam.width, cam.height, ui, cam.inset);
    const exclusions = reserved.length ? [...hud, ...reserved] : hud;

    if (style && DOM_STYLES.includes(style)) {
      if (!this.dom) this.dom = new DomLabels(layer);
      if (!this.domBuilt) { this.dom.build(visibleEntries, this.press); this.domBuilt = true; }
      this.dom.update(cam, style as DomLabelStyle, spec, content, this.scene.zoomOutFactor(), exclusions, now, this.scene.anchorHeightScale());
    } else this.dom?.hide();

    if (style === 'holo') {
      if (!this.holo) this.holo = new HoloLabels(layer);
      if (!this.holoBuilt) { this.holo.build(visibleEntries, this.press); this.holoBuilt = true; }
      this.holo.update(cam, spec.content, content, exclusions, groundY, now, this.scene.anchorHeightScale());
    } else this.holo?.hide();

    if (style === 'ground' || style === 'sign') {
      if (!this.world3d) {
        this.world3d = new WorldLabels3D(this.scene.container.ownerDocument);
        this.scene.groups.dynamic.add(this.world3d.group);
      }
      const key = `${style}|${spec.content}|${this.contentVersion}|${this.indexVersion}`;
      if (this.world3d.built !== key) this.world3d.build(style, visibleEntries, world, this.scene.materials, spec.content, content, groundY, key);
      this.world3d.group.visible = true;
      this.world3d.step(cam.orbit.bearing, groundY, this.scene.anchorHeightScale(), cam.orbit.distance);
    } else if (this.world3d) this.world3d.group.visible = false;
  }

  /**
   * True while the labels still need frames: a holo card that was hidden has
   * to be updated once more, 320 ms later, to leave the layout.
   */
  get animating(): boolean {
    return this.holo?.animating ?? false;
  }

  /** Currently shown holo label ids (tooling). */
  shownHolo(): string[] {
    return this.holo?.shownIds() ?? [];
  }

  pressAt(x: number, y: number): boolean {
    const spec = resolveLabels(this.scene.labels());
    if (!spec.enabled || (spec.style !== 'ground' && spec.style !== 'sign') || !this.world3d?.group.visible) return false;
    const hits = this.scene.camera.rayAt(x, y).intersectObject(this.world3d.group, true);
    for (const hit of hits) {
      let object = hit.object;
      let visible = object.visible;
      for (let parent = object.parent; parent; parent = parent.parent) visible &&= parent.visible;
      if (!visible) continue;
      while (object.parent && !object.userData.labelId) object = object.parent;
      if (typeof object.userData.labelId === 'string') { this.press(object.userData.labelId); return true; }
    }
    return false;
  }

  dispose(): void {
    this.dom?.clear();
    this.holo?.clear();
    if (this.world3d) {
      this.world3d.clear();
      this.scene.groups.dynamic.remove(this.world3d.group);
    }
    this.layer?.remove();
  }
}
