import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceFallbackReason, InferenceWorkerMessage, InferenceWorkerResponse } from '../../src/runtime/protocol';

const fallbackProcess = vi.fn();
const fallbackInit = vi.fn(async () => ({
  runtime: 'main-thread' as const,
  delegate: 'CPU' as const,
  modelVersion: 'test-model',
  liveStreamFallback: true,
}));
const fallbackClose = vi.fn();

vi.mock('../../src/runtime/handLandmarkerEngine', () => ({
  HandLandmarkerEngine: class {
    init = fallbackInit;
    process = fallbackProcess;
    close = fallbackClose;
  },
}));

class FakeBitmap {
  close = vi.fn();
}

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  static holdReady = false;
  static initError: string | undefined;
  static initFallbackReasons: InferenceFallbackReason[] | undefined;
  readonly terminated = vi.fn();
  readonly posted: InferenceWorkerMessage[] = [];

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: InferenceWorkerMessage): void {
    this.posted.push(message);
    if (message.type === 'init') {
      if (FakeWorker.holdReady) return;
      if (FakeWorker.initError) {
        queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { message: FakeWorker.initError })));
        return;
      }
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent<InferenceWorkerResponse>('message', {
          data: {
            type: 'ready',
            requestId: message.requestId,
            result: {
              runtime: 'worker',
              delegate: 'GPU',
              modelVersion: 'test-model',
              liveStreamFallback: true,
              fallbackReasons: FakeWorker.initFallbackReasons,
            },
          },
        }));
      });
    }
  }

  terminate(): void {
    this.terminated();
  }

  fail(message = 'worker exploded'): void {
    this.dispatchEvent(new ErrorEvent('error', { message }));
  }
}

describe('InferenceClient worker failure handling', () => {
  const originalWorker = globalThis.Worker;
  const originalBitmap = globalThis.ImageBitmap;
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  afterEach(() => {
    vi.restoreAllMocks();
    FakeWorker.instances.length = 0;
    FakeWorker.holdReady = false;
    FakeWorker.initError = undefined;
    FakeWorker.initFallbackReasons = undefined;
    fallbackInit.mockClear();
    fallbackProcess.mockReset();
    fallbackClose.mockClear();
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: originalBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: originalCreateImageBitmap });
  });

  it('rejects an in-flight frame and falls back after a runtime worker error', async () => {
    const bitmap = new FakeBitmap();
    fallbackProcess.mockReturnValue({
      frame: 2,
      time: 0.2,
      timestamp_us: 200_000,
      width: 2,
      height: 2,
      candidates: [],
      inferenceMs: 0,
      delegate: 'CPU',
    });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: vi.fn(async () => bitmap) });

    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();
    await expect(client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true })).resolves.toMatchObject({
      runtime: 'worker',
      delegate: 'GPU',
    });
    expect(client.executionDelegate).toBe('GPU');
    const worker = FakeWorker.instances[0];
    expect(worker).toBeDefined();

    const pending = client.process({
      frame: 1,
      time: 0.1,
      timestamp_us: 100_000,
      width: 2,
      height: 2,
      image: {} as HTMLVideoElement,
    });
    await Promise.resolve();
    worker?.fail();

    await expect(pending).rejects.toThrow('worker exploded');
    expect(worker?.terminated).toHaveBeenCalledTimes(1);

    // The recovery init is asynchronous; the next request must still settle
    // and use the main-thread engine once the fallback is ready.
    await vi.waitFor(() => expect(client.executionRuntime).toBe('main-thread'));
    await expect(client.process({
      frame: 2,
      time: 0.2,
      timestamp_us: 200_000,
      width: 2,
      height: 2,
      image: {} as HTMLVideoElement,
    })).resolves.toMatchObject({ frame: 2, delegate: 'CPU' });
    expect(fallbackProcess).toHaveBeenCalledTimes(1);
    expect(client.executionDelegate).toBe('CPU');
    expect(client.fallbackReason).toMatchObject({
      code: 'worker_runtime_failed',
      phase: 'runtime',
      message: 'worker exploded',
    });
  });

  it('rebuilds the worker when a new inference session is initialized', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: vi.fn() });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();
    const options = { modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true, mode: 'realtime' as const };

    await expect(client.init(options)).resolves.toMatchObject({ runtime: 'worker' });
    const firstWorker = FakeWorker.instances[0];
    await expect(client.init({ ...options, mode: 'precise' })).resolves.toMatchObject({ runtime: 'worker' });

    expect(firstWorker?.terminated).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(client.executionRuntime).toBe('worker');
  });

  it('makes delegate fallback provenance from a worker result consumable', async () => {
    const reason: InferenceFallbackReason = {
      code: 'gpu_delegate_unavailable',
      phase: 'initialization',
      message: 'GPU delegate initialization failed (Error); CPU delegate selected.',
    };
    FakeWorker.initFallbackReasons = [reason];
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: vi.fn() });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();

    await expect(client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true })).resolves.toMatchObject({
      runtime: 'worker',
      fallbackReasons: [reason],
    });
    expect(client.consumeFallbackReasons()).toEqual([reason]);
    expect(client.fallbackReasons).toEqual([]);
  });

  it('cancels a superseded worker initialization without waiting for its timeout', async () => {
    FakeWorker.holdReady = true;
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: vi.fn() });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();
    const first = client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true, mode: 'realtime' });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));

    FakeWorker.holdReady = false;
    const second = client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true, mode: 'precise' });
    await expect(first).rejects.toThrow('Inference initialization superseded');
    await expect(second).resolves.toMatchObject({ runtime: 'worker' });
    expect(FakeWorker.instances[0]?.terminated).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances[1]?.terminated).not.toHaveBeenCalled();
  });

  it('recreates the main-thread engine for consecutive precise sessions', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: undefined });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();
    const options = { modelUrl: '/model', wasmUrl: '/wasm', preferWorker: false, mode: 'precise' as const };

    await expect(client.init(options)).resolves.toMatchObject({ runtime: 'main-thread' });
    await expect(client.init(options)).resolves.toMatchObject({ runtime: 'main-thread' });
    expect(fallbackInit).toHaveBeenCalledTimes(2);
    expect(fallbackClose).toHaveBeenCalledTimes(1);
    expect(client.executionDelegate).toBe('CPU');
    expect(client.fallbackReasons).toEqual([]);
  });

  it('reports the actual delegate and reason after worker initialization fails', async () => {
    FakeWorker.initError = 'module startup failed';
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: vi.fn() });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();

    await expect(client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true })).resolves.toMatchObject({
      runtime: 'main-thread',
      delegate: 'CPU',
    });

    expect(client.executionRuntime).toBe('main-thread');
    expect(client.executionDelegate).toBe('CPU');
    expect(client.fallbackReason).toEqual({
      code: 'worker_initialization_failed',
      phase: 'initialization',
      message: 'module startup failed',
    });
    expect(FakeWorker.instances[0]?.terminated).toHaveBeenCalledTimes(1);
  });

  it('records delegate provenance from a main-thread initialization result', async () => {
    const reason: InferenceFallbackReason = {
      code: 'gpu_delegate_unavailable',
      phase: 'initialization',
      message: 'GPU delegate initialization failed (Error); CPU delegate selected.',
    };
    fallbackInit.mockResolvedValueOnce({
      runtime: 'main-thread',
      delegate: 'CPU',
      modelVersion: 'test-model',
      liveStreamFallback: true,
      fallbackReasons: [reason],
    });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: undefined });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();

    await expect(client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: false })).resolves.toMatchObject({
      runtime: 'main-thread',
      delegate: 'CPU',
      fallbackReasons: [reason],
    });
    expect(client.fallbackReasons).toEqual([reason]);
  });

  it('preserves delegate provenance while rebuilding after a runtime worker failure', async () => {
    const reason: InferenceFallbackReason = {
      code: 'gpu_delegate_unavailable',
      phase: 'initialization',
      message: 'GPU delegate initialization failed (Error); CPU delegate selected.',
    };
    fallbackInit.mockResolvedValueOnce({
      runtime: 'main-thread',
      delegate: 'CPU',
      modelVersion: 'test-model',
      liveStreamFallback: true,
      fallbackReasons: [reason],
    });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: vi.fn() });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();
    await client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true });

    FakeWorker.instances[0]?.fail('worker stopped');

    await vi.waitFor(() => expect(client.executionDelegate).toBe('CPU'));
    expect(client.fallbackReasons).toEqual([
      { code: 'worker_runtime_failed', phase: 'runtime', message: 'worker stopped' },
      reason,
    ]);
  });

  it.each([
    ['ImageBitmap', undefined, vi.fn()],
    ['createImageBitmap', FakeBitmap, undefined],
  ])('uses the main thread when %s transfer support is unavailable', async (_missing, bitmap, createBitmap) => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: bitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: createBitmap });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();

    await expect(client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true })).resolves.toMatchObject({
      runtime: 'main-thread',
    });

    expect(FakeWorker.instances).toHaveLength(0);
    expect(fallbackInit).toHaveBeenCalledTimes(1);
    expect(client.executionDelegate).toBe('CPU');
    expect(client.fallbackReason).toMatchObject({
      code: 'worker_frame_transfer_unavailable',
      phase: 'capability',
    });
  });

  it('falls back to the main thread when a worker frame snapshot fails', async () => {
    fallbackProcess.mockReturnValue({
      frame: 4,
      time: 0.4,
      timestamp_us: 400_000,
      width: 2,
      height: 2,
      candidates: [],
      inferenceMs: 1,
      delegate: 'CPU',
    });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => { throw new Error('snapshot rejected'); }),
    });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();
    await client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true });
    const worker = FakeWorker.instances[0];
    const video = document.createElement('video');

    await expect(client.process({
      frame: 4,
      time: 0.4,
      timestamp_us: 400_000,
      width: 2,
      height: 2,
      image: video,
    })).resolves.toMatchObject({ frame: 4, delegate: 'CPU' });

    expect(worker?.terminated).toHaveBeenCalledTimes(1);
    expect(fallbackInit).toHaveBeenCalledTimes(1);
    expect(fallbackProcess).toHaveBeenCalledWith(expect.objectContaining({ image: video }));
    expect(client.executionRuntime).toBe('main-thread');
    expect(client.executionDelegate).toBe('CPU');
    expect(client.fallbackReason).toEqual({
      code: 'worker_frame_snapshot_failed',
      phase: 'runtime',
      message: 'snapshot rejected',
    });
    expect(client.consumeFallbackReasons()).toEqual([{
      code: 'worker_frame_snapshot_failed',
      phase: 'runtime',
      message: 'snapshot rejected',
    }]);
    expect(client.fallbackReason).toBeUndefined();
    expect(client.fallbackReasons).toEqual([]);
  });

  it('does not deliver a late bitmap from an old session to a replacement worker', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: FakeBitmap });
    let resolveBitmap: ((bitmap: FakeBitmap) => void) | undefined;
    const bitmapReady = new Promise<FakeBitmap>((resolve) => { resolveBitmap = resolve; });
    const createBitmap = vi.fn(() => bitmapReady);
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: createBitmap });
    const { InferenceClient } = await import('../../src/runtime/inferenceClient');
    const client = new InferenceClient();
    const options = { modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true, mode: 'precise' as const };
    await client.init(options);
    const firstWorker = FakeWorker.instances[0];

    const oldFrame = client.process({
      frame: 8,
      time: 0.8,
      timestamp_us: 800_000,
      width: 2,
      height: 2,
      image: document.createElement('video'),
    });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(1));
    await client.init(options);
    const replacementWorker = FakeWorker.instances[1];
    const bitmap = new FakeBitmap();
    resolveBitmap?.(bitmap);

    await expect(oldFrame).rejects.toThrow('Inference frame superseded');
    expect(firstWorker?.terminated).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(replacementWorker?.posted.filter((message) => message.type === 'frame')).toHaveLength(0);
    expect(client.executionRuntime).toBe('worker');
  });
});
