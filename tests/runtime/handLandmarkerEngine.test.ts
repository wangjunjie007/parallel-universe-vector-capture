import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandLandmarkerEngine } from '../../src/runtime/handLandmarkerEngine';
import type { InferenceFrameInput } from '../../src/runtime/protocol';

class FakeBitmap {
  close = vi.fn();
}

class FakeVideoFrame {
  close = vi.fn();
}

type FakeLandmarker = {
  detectForVideo: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const originalBitmap = globalThis.ImageBitmap;
const originalVideoFrame = globalThis.VideoFrame;

const makeInput = (image: InferenceFrameInput['image']): InferenceFrameInput => ({
  frame: 3,
  time: 0.1,
  timestamp_us: 100_000,
  width: 1280,
  height: 720,
  image,
});

const installLandmarker = (engine: HandLandmarkerEngine, landmarker: FakeLandmarker): void => {
  Object.assign(engine, { landmarker, delegate: 'CPU' });
};

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: originalBitmap });
  Object.defineProperty(globalThis, 'VideoFrame', { configurable: true, writable: true, value: originalVideoFrame });
});

describe('HandLandmarkerEngine frame ownership', () => {
  it('releases an ImageBitmap after successful inference', () => {
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    const bitmap = new FakeBitmap();
    const landmarker = {
      detectForVideo: vi.fn(() => ({ landmarks: [], handedness: [] })),
      close: vi.fn(),
    };
    const engine = new HandLandmarkerEngine();
    installLandmarker(engine, landmarker);

    expect(engine.process(makeInput(bitmap as unknown as ImageBitmap))).toMatchObject({
      frame: 3,
      candidates: [],
      delegate: 'CPU',
    });
    expect(landmarker.detectForVideo).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('releases a VideoFrame and preserves the inference error', () => {
    Object.defineProperty(globalThis, 'VideoFrame', { configurable: true, writable: true, value: FakeVideoFrame });
    const frame = new FakeVideoFrame();
    const landmarker = {
      detectForVideo: vi.fn(() => { throw new Error('detect failed'); }),
      close: vi.fn(),
    };
    const engine = new HandLandmarkerEngine();
    installLandmarker(engine, landmarker);

    expect(() => engine.process(makeInput(frame as unknown as VideoFrame))).toThrow('detect failed');
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it('releases a late frame after cancellation closed the engine', () => {
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    const bitmap = new FakeBitmap();
    const engine = new HandLandmarkerEngine();

    engine.close();

    expect(() => engine.process(makeInput(bitmap as unknown as ImageBitmap))).toThrow('Hand landmarker is not initialized');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('does not treat an HTMLVideoElement as an owned frame resource', () => {
    const video = document.createElement('video');
    const landmarker = {
      detectForVideo: vi.fn(() => ({ landmarks: [], handedness: [] })),
      close: vi.fn(),
    };
    const engine = new HandLandmarkerEngine();
    installLandmarker(engine, landmarker);

    expect(() => engine.process(makeInput(video))).not.toThrow();
    expect('close' in video).toBe(false);
  });
});
