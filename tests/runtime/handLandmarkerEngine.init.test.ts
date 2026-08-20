import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  createFromOptions: vi.fn(),
  fetchVerifiedBytes: vi.fn(),
  forVisionTasks: vi.fn(),
  isSimdSupported: vi.fn(),
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {
    forVisionTasks: runtimeMocks.forVisionTasks,
    isSimdSupported: runtimeMocks.isSimdSupported,
  },
  HandLandmarker: {
    createFromOptions: runtimeMocks.createFromOptions,
  },
}));

vi.mock('../../src/runtime/assetIntegrity', () => ({
  fetchVerifiedBytes: runtimeMocks.fetchVerifiedBytes,
}));

import { HandLandmarkerEngine } from '../../src/runtime/handLandmarkerEngine';

describe('HandLandmarkerEngine delegate provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.fetchVerifiedBytes.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      sha256: 'verified-sha256',
    });
    runtimeMocks.isSimdSupported.mockResolvedValue(true);
    runtimeMocks.forVisionTasks.mockResolvedValue({});
  });

  it('returns a safe structured reason when CPU replaces an unavailable GPU delegate', async () => {
    const landmarker = { close: vi.fn(), detectForVideo: vi.fn() };
    const gpuError = new Error('GPU failed at https://private.invalid/model?token=secret');
    gpuError.name = 'private token context';
    runtimeMocks.createFromOptions
      .mockRejectedValueOnce(gpuError)
      .mockResolvedValueOnce(landmarker);
    const engine = new HandLandmarkerEngine();

    const result = await engine.init({
      modelUrl: '/assets/hand.task',
      wasmUrl: '/assets/wasm',
      preferGpu: true,
    });

    expect(result).toMatchObject({
      runtime: 'main-thread',
      delegate: 'CPU',
      fallbackReasons: [{
        code: 'gpu_delegate_unavailable',
        phase: 'initialization',
        message: 'GPU delegate initialization failed (unknown error); CPU delegate selected.',
      }],
    });
    expect(JSON.stringify(result.fallbackReasons)).not.toContain('private.invalid');
    expect(JSON.stringify(result.fallbackReasons)).not.toContain('token=secret');
    expect(JSON.stringify(result.fallbackReasons)).not.toContain('private token context');
    expect(runtimeMocks.createFromOptions).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ baseOptions: expect.objectContaining({ delegate: 'GPU' }) }),
    );
    expect(runtimeMocks.createFromOptions).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ baseOptions: expect.objectContaining({ delegate: 'CPU' }) }),
    );

    engine.close();
    expect(landmarker.close).toHaveBeenCalledTimes(1);
  });

  it('does not report a fallback when CPU was explicitly requested', async () => {
    runtimeMocks.createFromOptions.mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn() });
    const engine = new HandLandmarkerEngine();

    const result = await engine.init({
      modelUrl: '/assets/hand.task',
      wasmUrl: '/assets/wasm',
      preferGpu: false,
    });

    expect(result.delegate).toBe('CPU');
    expect(result.fallbackReasons).toBeUndefined();
    expect(runtimeMocks.createFromOptions).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.createFromOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ baseOptions: expect.objectContaining({ delegate: 'CPU' }) }),
    );

    engine.close();
  });
});
