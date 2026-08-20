import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useLocalCaptureController } from '../src/App';
import type { InferenceFallbackReason } from '../src/runtime/protocol';
import type { CaptureUiController } from '../src/ui/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const fakes = vi.hoisted(() => {
  const initializationReason: InferenceFallbackReason = {
    code: 'gpu_delegate_unavailable',
    phase: 'initialization',
    message: 'GPU delegate initialization failed (Error); CPU delegate selected.',
  };

  class FakeCameraSession {
    static instances: FakeCameraSession[] = [];
    readonly mediaStream = {} as MediaStream;
    readonly startFrames = vi.fn();
    readonly stopFrames = vi.fn();
    readonly stop = vi.fn();
    readonly setMirror = vi.fn();
    readonly setCallbacks = vi.fn();
    readonly enumerateCameras = vi.fn(async () => []);

    constructor() {
      FakeCameraSession.instances.push(this);
    }

    readonly request = vi.fn(async () => ({ width: 640, height: 480, frameRate: 30 }));
  }

  class FakeInferenceClient {
    static instances: FakeInferenceClient[] = [];
    readonly executionRuntime = 'main-thread' as const;
    readonly executionDelegate = 'CPU' as const;
    readonly init = vi.fn(async () => ({
      runtime: 'main-thread' as const,
      delegate: 'CPU' as const,
      modelVersion: 'test-model',
      liveStreamFallback: true,
      fallbackReasons: [...this.pendingReasons],
    }));
    readonly process = vi.fn(async () => null);
    readonly dispose = vi.fn();
    private pendingReasons: InferenceFallbackReason[] = [initializationReason];

    constructor() {
      FakeInferenceClient.instances.push(this);
    }

    consumeFallbackReasons(): InferenceFallbackReason[] {
      return this.pendingReasons.splice(0);
    }

    queueFallback(reason: InferenceFallbackReason): void {
      this.pendingReasons.push(reason);
    }
  }

  return { FakeCameraSession, FakeInferenceClient, initializationReason };
});

vi.mock('../src/runtime/cameraSession', () => ({
  CameraSession: fakes.FakeCameraSession,
  cameraErrorMessage: (error: unknown) => error instanceof Error ? error.message : 'camera error',
  isCameraSecureContext: () => true,
}));

vi.mock('../src/runtime/inferenceClient', () => ({ InferenceClient: fakes.FakeInferenceClient }));

describe('live capture initialization provenance', () => {
  let root: Root;
  let container: HTMLDivElement;
  let controller: CaptureUiController & { videoRef: React.RefObject<HTMLVideoElement> };

  function Harness(): null {
    controller = useLocalCaptureController('en');
    return null;
  }

  beforeEach(async () => {
    fakes.FakeCameraSession.instances.length = 0;
    fakes.FakeInferenceClient.instances.length = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({} as MediaStream)) },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('keeps initialization fallback diagnostics after a new camera starts', async () => {
    await act(async () => {
      await controller.actions.requestCamera();
    });

    expect(controller.snapshot.phase).toBe('preview');
    expect(controller.snapshot.diagnostics.some((item) => item.title.includes('GPU delegate initialization failed'))).toBe(true);
    expect(controller.snapshot.source.mirrored).toBe(true);
  });

  it('keeps a pending runtime fallback diagnostic when an existing stream restarts', async () => {
    await act(async () => {
      await controller.actions.requestCamera();
    });
    const client = fakes.FakeInferenceClient.instances[0];
    expect(client).toBeDefined();
    client?.queueFallback({
      code: 'worker_runtime_failed',
      phase: 'runtime',
      message: 'worker stopped; inference moved to the main thread.',
    });

    await act(async () => {
      await controller.actions.startPreview();
    });

    expect(controller.snapshot.phase).toBe('preview');
    expect(controller.snapshot.diagnostics.some((item) => item.title.includes('worker stopped'))).toBe(true);
  });

  it('keeps a pending fallback diagnostic when switching cameras reuses the model', async () => {
    await act(async () => {
      await controller.actions.requestCamera();
    });
    const client = fakes.FakeInferenceClient.instances[0];
    client?.queueFallback({
      code: 'worker_runtime_failed',
      phase: 'runtime',
      message: 'worker stopped during camera switch; inference moved to the main thread.',
    });

    await act(async () => {
      await controller.actions.selectCamera('camera-2');
    });

    expect(controller.snapshot.phase).toBe('preview');
    expect(controller.snapshot.diagnostics.some((item) => item.title.includes('worker stopped during camera switch'))).toBe(true);
  });
});
