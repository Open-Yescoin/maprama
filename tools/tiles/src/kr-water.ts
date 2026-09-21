/**
 * Water from Korean public data instead of OpenStreetMap.
 *
 * The 국토지리정보원 연속수치지형도 layers published on the V-World download
 * (`dtmk`) carry the whole country's rivers, banks and lakes under **CC BY**,
 * with no share-alike — which is what makes an ODbL-free national build
 * possible at all. `design/korea-data-sources.md` has the licence trail.
 *
 *   실폭하천  dsId=30207   N3A_E0032111.zip
 *   하천경계  dsId=30248   N3A_E0010001.zip
 *   호소      dsId=30256   N3A_E0052114.zip
 *
 * Two things differ from {@link ./kr-parks.ts}:
 *
 *  - the CRS is **EPSG:5179** (UTM-K on GRS80), not the EPSG:5174 the 토지이음
 *    facility shapefiles use, so it needs no datum shift;
 *  - the V-World pages do not state the geometry type, and nobody has been able
 *    to open these files yet — the download is behind a login. So the converter
 *    **refuses to guess**: if the shapefiles turn out to hold polylines rather
 *    than polygons it stops and says so, because turning a centre line into a
 *    river means choosing a width, and a wrong width is a wrong map.
 *
 * Build step (once the zips are unpacked somewhere):
 *
 * ```
 * maprama-tiles kr-water --src <dir> --out kr-water.json
 * maprama-tiles build ... --kr-water kr-water.json
 * ```
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { epsg5179ToWgs84 } from './kr-proj.js';
import { readPolygonShapefile, signedArea } from './shapefile.js';
import type { LngLat } from './mercator.js';
import type { Region, TileSource } from './sources.js';
import { emptyBundle, type GeoBundle, type GeoWater, type LayerName } from './types.js';

export const KR_WATER_ATTRIBUTION =
  '수계: 연속수치지형도 — 국토지리정보원 (CC BY)';

/** Rings smaller than this are ponds the size of a parking space; they cost bytes and draw nothing. */
export const DEFAULT_KR_WATER_MIN_AREA_M2 = 400;

export interface KrWaterStats {
  files: number;
  records: number;
  rings: number;
  kept: number;
  droppedSmall: number;
  areaKm2: number;
}

export interface KrWaterFile {
  format: 'maprama-kr-water-1';
  attribution: string;
  minAreaM2: number;
  stats: KrWaterStats;
  /** Flat `[lng, lat, lng, lat, …]` per ring. */
  water: number[][];
}

/**
 * Reads every `.shp` under `dir` and converts the polygons to WGS 84.
 *
 * Throws when a file parses to nothing but empty records, which is what
 * {@link readPolygonShapefile} produces for a polyline shapefile.
 */
export async function convertKrWater(
  dir: string,
  minAreaM2 = DEFAULT_KR_WATER_MIN_AREA_M2,
  log: (message: string) => void = () => {},
): Promise<{ water: GeoWater[]; stats: KrWaterStats }> {
  const stats: KrWaterStats = { files: 0, records: 0, rings: 0, kept: 0, droppedSmall: 0, areaKm2: 0 };
  const water: GeoWater[] = [];
  const shps = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.shp'))
    .map((e) => join(e.parentPath ?? dir, e.name))
    .sort();
  if (shps.length === 0) throw new Error(`kr-water: no .shp under ${dir}`);

  for (const path of shps) {
    stats.files++;
    const records = await readPolygonShapefile(path);
    stats.records += records.length;
    let ringsHere = 0;
    for (const rec of records) {
      for (const part of rec.parts) {
        ringsHere++;
        stats.rings++;
        // Outer rings only: `GeoWater` has no hole, so an island inside a lake
        // is dropped rather than drawn as water. Recorded, not hidden.
        if (signedArea(part) <= 0) continue;
        const poly: LngLat[] = part.map(([x, y]) => epsg5179ToWgs84(x, y));
        const areaM2 = Math.abs(signedArea(part));
        if (areaM2 < minAreaM2) {
          stats.droppedSmall++;
          continue;
        }
        water.push({ poly });
        stats.kept++;
        stats.areaKm2 += areaM2 / 1e6;
      }
    }
    log(`kr-water: ${path.split('/').pop()} -> ${ringsHere} rings, ${stats.kept} kept so far`);
  }

  if (stats.rings === 0) {
    throw new Error(
      `kr-water: ${stats.records} records across ${stats.files} file(s) produced no polygon rings. ` +
        'These shapefiles are polylines, not polygons — turning a river centre line into a water ' +
        'surface needs a width per feature, which this converter will not invent. Check the layer ' +
        '(실폭하천 should be polygonal) or add an explicit width rule before using it.',
    );
  }
  return { water, stats };
}

/** Packs converted water into the on-disk form. Coordinates rounded to ~1 cm. */
export function encodeKrWaterFile(water: readonly GeoWater[], stats: KrWaterStats, minAreaM2: number): KrWaterFile {
  return {
    format: 'maprama-kr-water-1',
    attribution: KR_WATER_ATTRIBUTION,
    minAreaM2,
    stats,
    water: water.map((w) => {
      const flat: number[] = [];
      for (const [lng, lat] of w.poly) flat.push(Number(lng.toFixed(7)), Number(lat.toFixed(7)));
      return flat;
    }),
  };
}

interface Box {
  west: number;
  east: number;
  south: number;
  north: number;
}

function boxOf(poly: readonly LngLat[]): Box {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [lng, lat] of poly) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, east, south, north };
}

export interface KrWaterSourceOptions {
  file: string;
  log?: (message: string) => void;
}

/** The `kr-water` source. Provides the `water` layer only. */
export class KrWaterSource implements TileSource {
  readonly id = 'kr-water';
  readonly provides: readonly LayerName[] = ['water'];
  readonly attribution: readonly string[] = [KR_WATER_ATTRIBUTION];

  #water: GeoWater[] = [];
  #boxes: Box[] = [];
  #loaded = false;
  #log: (message: string) => void;

  constructor(readonly options: KrWaterSourceOptions) {
    this.#log = options.log ?? ((): void => {});
  }

  async prepare(): Promise<void> {
    if (this.#loaded) return;
    const file = JSON.parse(await readFile(this.options.file, 'utf8')) as KrWaterFile;
    if (file.format !== 'maprama-kr-water-1') {
      throw new Error(`${this.options.file}: not a maprama-kr-water-1 file (got "${String(file.format)}")`);
    }
    this.#water = file.water.map((flat) => {
      const poly: LngLat[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) poly.push([flat[i]!, flat[i + 1]!]);
      return { poly };
    });
    this.#boxes = this.#water.map((w) => boxOf(w.poly));
    this.#loaded = true;
    this.#log(`kr-water: ${this.#water.length.toLocaleString()} polygons from ${this.options.file}`);
  }

  async load(region: Region): Promise<GeoBundle> {
    await this.prepare();
    const b = region.padded;
    const out = emptyBundle();
    for (let i = 0; i < this.#water.length; i++) {
      const box = this.#boxes[i]!;
      if (box.east < b.west || box.west > b.east || box.north < b.south || box.south > b.north) continue;
      out.water.push(this.#water[i]!);
    }
    return out;
  }

  /** Nothing to release: the whole index is kept for the run, like `kr-parks`. */
  release(): void {}
}
