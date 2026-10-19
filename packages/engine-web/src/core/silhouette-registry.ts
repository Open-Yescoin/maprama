/**
 * Which objects are currently registered for the silhouette passes.
 *
 * The renderer used to latch this on the first `addSilhouette` call and never
 * turn the two extra full-scene passes off again: one character that had ever
 * appeared cost every later frame forever. This registry reference counts the
 * registered objects instead, so the passes run exactly while at least one
 * silhouette is alive.
 *
 * It imports nothing but the `Object3D` type (no three.js value, no DOM), so
 * the bookkeeping is unit-testable in node without a `WebGLRenderer`.
 *
 * @module
 */

import type { Object3D } from 'three';

export class SilhouetteRegistry {
  private readonly objects = new Set<Object3D>();

  /** True while at least one object is registered (the extra passes are needed). */
  get active(): boolean {
    return this.objects.size > 0;
  }

  /** Number of distinct registered objects. */
  get size(): number {
    return this.objects.size;
  }

  /** Registers `obj`; registering the same object again is a no-op. Returns `true` when it was new. */
  add(obj: Object3D): boolean {
    if (this.objects.has(obj)) return false;
    this.objects.add(obj);
    return true;
  }

  /** Unregisters `obj`; removing an object that was never added is a no-op. Returns `true` when it was registered. */
  remove(obj: Object3D): boolean {
    return this.objects.delete(obj);
  }

  /** Forgets every object (engine teardown). */
  clear(): void {
    this.objects.clear();
  }
}
