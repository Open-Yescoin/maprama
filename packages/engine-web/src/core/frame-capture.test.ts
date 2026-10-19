/**
 * `FrameCapture` is the bounded buffer behind the engine's frame trace (plan
 * item M1). It has no three.js or DOM dependency, so its contract — off by
 * default, bounded, restart returns the previous run — is tested directly.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FRAME_CAPTURE_LIMIT, FrameCapture, type CapturedFrame } from './frame-capture.js';

function sample(dt: number): CapturedFrame {
  return { dt, shadowRedrawn: false, passes: 1, drawCalls: 12, activeSources: [] };
}

describe('FrameCapture', () => {
  it('records nothing until it is armed', () => {
    const capture = new FrameCapture();
    capture.record(sample(16));
    expect(capture.capturing).toBe(false);
    expect(capture.frames()).toEqual([]);
  });

  it('keeps the samples in order up to the bound and then refuses more', () => {
    const capture = new FrameCapture();
    capture.start(3);
    capture.record(sample(10));
    capture.record(sample(20));
    capture.record(sample(30));
    // Past the bound the buffer is full and the frame is dropped, not appended:
    // a forgotten capture must not grow without limit.
    capture.record(sample(40));
    expect(capture.frames().map((f) => f.dt)).toEqual([10, 20, 30]);
    expect(capture.capturing).toBe(false);
  });

  it('hands back the previous run when it is re-armed', () => {
    const capture = new FrameCapture();
    capture.start(10);
    capture.record(sample(16));
    // Re-arming must return what was never read, or a measurement would vanish
    // silently between two probe calls.
    const previous = capture.start(10);
    expect(previous.map((f) => f.dt)).toEqual([16]);
    expect(capture.frames()).toEqual([]);
    expect(capture.capturing).toBe(true);
  });

  it('stops early and still reports what it recorded', () => {
    const capture = new FrameCapture();
    capture.start(10);
    capture.record(sample(16));
    capture.record(sample(17));
    capture.stop();
    capture.record(sample(18));
    expect(capture.frames().map((f) => f.dt)).toEqual([16, 17]);
    expect(capture.capturing).toBe(false);
  });

  it('treats a zero or negative limit as off', () => {
    const capture = new FrameCapture();
    capture.start(0);
    capture.record(sample(16));
    expect(capture.frames()).toEqual([]);
    expect(capture.capturing).toBe(false);
    capture.start(-5);
    expect(capture.capturing).toBe(false);
  });

  it('copies on read, so a caller cannot mutate the buffer', () => {
    const capture = new FrameCapture();
    capture.start(5);
    capture.record(sample(16));
    capture.frames().push(sample(99));
    expect(capture.frames()).toHaveLength(1);
  });

  it('defaults to a bound that fits about ten seconds at 60fps', () => {
    expect(DEFAULT_FRAME_CAPTURE_LIMIT).toBeGreaterThanOrEqual(600);
  });
});
