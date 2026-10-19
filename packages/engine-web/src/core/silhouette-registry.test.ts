import { Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { SilhouetteRegistry } from './silhouette-registry.js';

describe('SilhouetteRegistry', () => {
  it('stays active while one of two registrations is still held', () => {
    const r = new SilhouetteRegistry();
    const a = new Object3D(), b = new Object3D();
    expect(r.active).toBe(false);
    expect(r.size).toBe(0);
    r.add(a);
    r.add(b);
    expect(r.size).toBe(2);
    r.remove(a);
    // one of two removed: the extra passes are still needed
    expect(r.active).toBe(true);
    expect(r.size).toBe(1);
    r.remove(b);
    expect(r.active).toBe(false);
    expect(r.size).toBe(0);
  });

  it('counts an object registered twice only once, so one removal is enough', () => {
    const r = new SilhouetteRegistry();
    const a = new Object3D();
    expect(r.add(a)).toBe(true);
    expect(r.add(a)).toBe(false);
    expect(r.size).toBe(1);
    r.remove(a);
    expect(r.active).toBe(false);
    expect(r.size).toBe(0);
  });

  it('ignores removing an object that was never registered', () => {
    const r = new SilhouetteRegistry();
    const a = new Object3D();
    expect(r.remove(a)).toBe(false);
    expect(r.active).toBe(false);
    expect(r.size).toBe(0);
    r.add(a);
    expect(r.remove(new Object3D())).toBe(false);
    expect(r.active).toBe(true);
    expect(r.size).toBe(1);
  });

  it('forgets every object on clear()', () => {
    const r = new SilhouetteRegistry();
    r.add(new Object3D());
    r.add(new Object3D());
    expect(r.size).toBe(2);
    r.clear();
    expect(r.active).toBe(false);
    expect(r.size).toBe(0);
  });
});
