import { describe, expect, it, vi } from 'vitest';
import { bindLabelPress } from './dom-styles.js';

describe('label input', () => {
  it('captures pointer gestures and emits one accessible press', () => {
    const target = Object.assign(new EventTarget(), { style: {}, setAttribute: vi.fn(), tabIndex: -1 });
    const press = vi.fn();
    bindLabelPress(target as unknown as HTMLElement, press);
    const down = new Event('pointerdown', { bubbles: true });
    const stop = vi.spyOn(down, 'stopPropagation');
    target.dispatchEvent(down);
    expect(stop).toHaveBeenCalledOnce();
    expect(press).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('click', { cancelable: true }));
    expect(press).toHaveBeenCalledOnce();
    target.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter' }));
    expect(press).toHaveBeenCalledTimes(2);
    expect(target.tabIndex).toBe(0);
  });
});
