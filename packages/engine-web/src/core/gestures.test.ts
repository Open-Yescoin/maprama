import { describe, expect, it, vi } from 'vitest';

import { GestureController } from './gestures.js';
import type { CameraController } from './camera.js';

function pointer(type: string, x: number, y: number): Event {
  return Object.assign(new Event(type), { pointerId: 1, clientX: x, clientY: y, button: 0, shiftKey: false, altKey: false, ctrlKey: false });
}

describe('GestureController input suspension', () => {
  it('ignores active and new gestures until enabled again', () => {
    const element = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: vi.fn() }) as unknown as HTMLElement;
    const camera = { orbit: { distance: 100 }, screenToGround: (x: number, y: number) => ({ x, z: y }), panBy: vi.fn(), apply: vi.fn(), zoomTo: vi.fn() } as unknown as CameraController;
    const onTap = vi.fn(), onInteract = vi.fn();
    const gestures = new GestureController(element, camera, { onTap, onInteract });

    element.dispatchEvent(pointer('pointerdown', 0, 0));
    gestures.setEnabled(false);
    element.dispatchEvent(pointer('pointermove', 20, 0));
    element.dispatchEvent(pointer('pointerup', 20, 0));
    element.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100 }));
    expect(camera.panBy).not.toHaveBeenCalled();
    expect(camera.zoomTo).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();

    gestures.setEnabled(true);
    element.dispatchEvent(pointer('pointermove', 30, 0));
    expect(camera.panBy).not.toHaveBeenCalled();
    element.dispatchEvent(pointer('pointerdown', 0, 0));
    element.dispatchEvent(pointer('pointermove', 20, 0));
    expect(camera.panBy).toHaveBeenCalledWith(-20, 0);
    element.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100 }));
    expect(vi.mocked(camera.zoomTo).mock.calls[0]?.[0]).toBeCloseTo(112);
    expect(onInteract).toHaveBeenCalledTimes(2);
    gestures.dispose();
  });
});
