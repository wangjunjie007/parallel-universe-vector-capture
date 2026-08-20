import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceWorkerMessage, InferenceWorkerResponse } from '../../src/runtime/protocol';

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
  readonly terminated = vi.fn();
  readonly posted: InferenceWorkerMessage[] = [];

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: InferenceWorkerMessage): void {
    this.posted.push(message);
    if (message.type === 'init') {
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent<InferenceWorkerResponse>('message', {
          data: {
            type: 'ready',
            requestId: message.requestId,
            result: {
              runtime: 'worker',
              delegate: 'CPU',
              modelVersion: 'test-model',
              liveStreamFallback: true,
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
    await expect(client.init({ modelUrl: '/model', wasmUrl: '/wasm', preferWorker: true })).resolves.toMatchObject({ runtime: 'worker' });
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
  });
});
