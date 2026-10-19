/**
 * `stepVehicles` no-op write guards.
 *
 * The pass only touches `group.visible`, `group.scale`, `group.rotation` (and,
 * for the car, `group.position`), so a minimal stub records the writes instead
 * of pulling in a real three.js scene: the point is to observe that a settled
 * vehicle writes nothing, not to reproduce the geometry.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type { Group } from 'three';
import { PLANE_SCALE, easeOutBack, stepVehicles, type Vehicle, type VehicleSet } from './vehicles.js';

interface StubGroup {
  visible: boolean;
  scale: { x: number; y: number; z: number; setScalar: (v: number) => void };
  rotation: { x: number; z: number };
  position: { y: number };
}

type Stub = ReturnType<typeof stubGroup>;

function stubGroup(scale = 0.001, visible = false): { group: StubGroup; scaleWrites: () => number; pitchWrites: () => number } {
  let scaleWrites = 0;
  let pitchWrites = 0;
  let rotationX = 0;
  const group: StubGroup = {
    visible,
    scale: {
      x: scale, y: scale, z: scale,
      setScalar(v: number) {
        this.x = v;
        this.y = v;
        this.z = v;
        scaleWrites += 1;
      },
    },
    rotation: {
      get x() {
        return rotationX;
      },
      set x(v: number) {
        rotationX = v;
        pitchWrites += 1;
      },
      z: 0,
    },
    position: { y: 0 },
  };
  return { group, scaleWrites: () => scaleWrites, pitchWrites: () => pitchWrites };
}

/** A `Vehicle` at its resting state: hidden, at the pop-out scale. */
function stubVehicle(group: StubGroup, base: number, p = 0, dir = 0): Vehicle {
  return { group: group as unknown as Group, p, dir, wheels: [], base, wheelR: 1 };
}

function stubSet(): { set: VehicleSet; bike: Stub; car: Stub; plane: Stub; subway: Stub } {
  const bike = stubGroup();
  const car = stubGroup();
  const plane = stubGroup();
  const subway = stubGroup();
  const set: VehicleSet = {
    bike: stubVehicle(bike.group, 1),
    car: stubVehicle(car.group, 1.25),
    plane: stubVehicle(plane.group, PLANE_SCALE),
    subway: stubVehicle(subway.group, 1),
  };
  return { set, bike, car, plane, subway };
}

describe('stepVehicles', () => {
  it('does not write to a settled, hidden vehicle', () => {
    const { set, bike, car, plane, subway } = stubSet();
    // `walk` matches no vehicle, so the wheel spin never runs either.
    stepVehicles(set, 'walk', 0, 0.016, 0, 0, false);
    // dir 0, p 0 and the applied scale already at the pop-out 0.001: nothing
    // can have changed, so the frame must not touch any of them.
    expect(bike.scaleWrites()).toBe(0);
    expect(car.scaleWrites()).toBe(0);
    expect(plane.scaleWrites()).toBe(0);
    expect(subway.scaleWrites()).toBe(0);
  });

  it('still writes a settling vehicle and lands on the eased scale', () => {
    const { set, car } = stubSet();
    car.group.visible = true;
    set.car.dir = 1;
    stepVehicles(set, 'walk', 0, 0.1, 0, 0, false);
    expect(set.car.p).toBeGreaterThan(0);
    expect(car.scaleWrites()).toBe(1);
    expect(car.group.scale.x).toBeCloseTo(Math.max(0.001, easeOutBack(set.car.p) * set.car.base), 10);
  });

  it('does not rewrite a fully appeared, settled vehicle', () => {
    const { set, car } = stubSet();
    car.group.visible = true;
    car.group.scale.x = car.group.scale.y = car.group.scale.z = 1.25;
    set.car.p = 1;
    set.car.dir = 0;
    stepVehicles(set, 'walk', 0, 0.016, 0, 0, false);
    expect(car.scaleWrites()).toBe(0);
  });

  it('writes the plane pitch only when it changed', () => {
    const { set, plane } = stubSet();
    stepVehicles(set, 'walk', 0, 0.016, 0, 0.2, false);
    expect(plane.group.rotation.x).toBeCloseTo(0.2, 10);
    expect(plane.pitchWrites()).toBe(1);
    // Same pitch on the next frame: the assignment is skipped.
    stepVehicles(set, 'walk', 0, 0.016, 0, 0.2, false);
    expect(plane.pitchWrites()).toBe(1);
  });
});
