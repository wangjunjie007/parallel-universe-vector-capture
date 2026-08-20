import { HandLandmarkerEngine } from './handLandmarkerEngine';
import type {
  InferenceFrameInput,
  InferenceFrameOutput,
  InferenceInitOptions,
  InferenceInitResult,
  InferenceWorkerMessage,
  InferenceWorkerResponse,
} from './protocol';

// Re-export this type for callers that import the client as their runtime boundary.
export type { InferenceInitResult } from './protocol';

type Pending = { resolve: (value: InferenceFrameOutput) => void; reject: (reason: unknown) => void };

export class InferenceClient {
  private worker: Worker | undefined;
  private fallback: HandLandmarkerEngine | undefined;
  private initOptions: InferenceInitOptions | undefined;
  private fallbackInitPromise: Promise<void> | undefined;
  private requestId = 0;
  private pending = new Map<number, Pending>();
  private busy = false;
  private initialized = false;
  private runtime: 'worker' | 'main-thread' = 'main-thread';
  private workerListener: ((event: MessageEvent<InferenceWorkerResponse>) => void) | undefined;
  private workerErrorListener: ((event: ErrorEvent) => void) | undefined;
  private lifecycle = 0;

  get executionRuntime(): 'worker' | 'main-thread' { return this.runtime; }

  async init(options: InferenceInitOptions): Promise<InferenceInitResult> {
    this.initOptions = { ...options };
    this.lifecycle += 1;
    const lifecycle = this.lifecycle;
    this.initialized = false;
    this.fallbackInitPromise = undefined;
    const preferWorker = options.preferWorker !== false && typeof Worker !== 'undefined';
    if (preferWorker) {
      try {
        const worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
        this.worker = worker;
        const result = await this.requestReady(worker, { ...options, useModuleWasm: true });
        this.attachWorkerHandler();
        this.runtime = 'worker';
        this.initialized = true;
        return { ...result, runtime: 'worker' };
      } catch {
        this.disposeWorker();
      }
    }
    const result = await this.initializeFallback(options, lifecycle);
    this.runtime = 'main-thread';
    this.initialized = true;
    return result;
  }

  async process(input: InferenceFrameInput): Promise<InferenceFrameOutput | null> {
    if (!this.initialized) throw new Error('Inference client is not initialized');
    if (this.runtime === 'main-thread' || !this.worker) {
      await this.ensureFallback();
      return this.fallback?.process(input) ?? null;
    }
    if (this.busy && input.dropIfBusy) {
      // Live mode applies backpressure rather than queueing stale camera frames.
      if (input.image instanceof ImageBitmap) input.image.close();
      return null;
    }
    if (this.busy) throw new Error('inference_busy_precise');
    const requestId = ++this.requestId;
    const image = input.image instanceof ImageBitmap
      ? input.image
      : await createImageBitmap(input.image);
    // The worker may fail while the source image is being prepared. Do not
    // enter the pending map after that failure: optional-chaining a missing
    // worker would leave a promise that can never settle.
    const worker = this.worker;
    if (this.runtime !== 'worker' || !worker) {
      try { image.close(); } catch { /* already detached */ }
      throw new Error('Inference worker failed');
    }
    this.busy = true;
    return new Promise<InferenceFrameOutput>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const { image: _image, ...frame } = input;
      const message: InferenceWorkerMessage = { type: 'frame', requestId, frame, image };
      try {
        worker.postMessage(message, [image]);
      } catch (error) {
        this.pending.delete(requestId);
        this.busy = false;
        try { image.close(); } catch { /* already detached */ }
        reject(error);
      }
    });
  }

  dispose(): void {
    this.lifecycle += 1;
    for (const pending of this.pending.values()) pending.reject(new Error('Inference client disposed'));
    this.pending.clear();
    this.disposeWorker(true);
    this.fallback?.close();
    this.fallback = undefined;
    this.initOptions = undefined;
    this.fallbackInitPromise = undefined;
    this.initialized = false;
    this.busy = false;
  }

  private requestReady(worker: Worker, options: InferenceInitOptions): Promise<InferenceInitResult> {
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      let settled = false;
      let timer: number | undefined;
      const onWorkerError = (event: ErrorEvent) => settle(new Error(event.message || 'Inference worker failed to start'));
      const settle = (error?: Error, result?: InferenceInitResult) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener('message', listener);
        worker.removeEventListener('error', onWorkerError);
        if (timer !== undefined) window.clearTimeout(timer);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const listener = (event: MessageEvent<InferenceWorkerResponse>) => {
        const response = event.data;
        if (response.requestId !== requestId) return;
        if (response.type === 'ready') settle(undefined, response.result);
        else if (response.type === 'error') settle(new Error(response.message));
        else settle(new Error('Unexpected inference worker response'));
      };
      timer = window.setTimeout(() => settle(new Error('Inference worker initialization timed out')), 30_000);
      worker.addEventListener('message', listener);
      worker.addEventListener('error', onWorkerError, { once: true });
      try {
        worker.postMessage({ type: 'init', requestId, options } satisfies InferenceWorkerMessage);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private attachWorkerHandler(): void {
    if (!this.worker) return;
    const listener = (event: MessageEvent<InferenceWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'result' || message.type === 'error') {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        this.busy = false;
        if (message.type === 'result') pending.resolve(message.result);
        else pending.reject(new Error(message.message));
      }
    };
    this.workerListener = listener;
    this.worker.addEventListener('message', listener);
    const worker = this.worker;
    const onWorkerError = (event: ErrorEvent) => {
      this.handleWorkerFailure(worker, new Error(event.message || 'Inference worker failed'));
    };
    this.workerErrorListener = onWorkerError;
    worker.addEventListener('error', onWorkerError, { once: true });
  }

  private async initializeFallback(options: InferenceInitOptions, lifecycle: number): Promise<InferenceInitResult> {
    const fallback = new HandLandmarkerEngine();
    try {
      const result = await fallback.init({ ...options, useModuleWasm: false });
      if (this.lifecycle !== lifecycle) {
        fallback.close();
        throw new Error('Inference client disposed during initialization');
      }
      this.fallback = fallback;
      return result;
    } catch (error) {
      fallback.close();
      throw error;
    }
  }

  private async ensureFallback(): Promise<void> {
    if (this.fallback) return;
    if (this.fallbackInitPromise) return this.fallbackInitPromise;
    const options = this.initOptions;
    if (!options) throw new Error('Inference client is not initialized');
    const lifecycle = this.lifecycle;
    this.fallbackInitPromise = this.initializeFallback(options, lifecycle)
      .then(() => {
        if (this.lifecycle !== lifecycle) throw new Error('Inference client disposed during fallback');
        this.runtime = 'main-thread';
        this.initialized = true;
      })
      .finally(() => { this.fallbackInitPromise = undefined; });
    try {
      await this.fallbackInitPromise;
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    if (this.workerListener) worker.removeEventListener('message', this.workerListener);
    if (this.workerErrorListener) worker.removeEventListener('error', this.workerErrorListener);
    this.worker = undefined;
    this.workerListener = undefined;
    this.workerErrorListener = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.busy = false;
    this.runtime = 'main-thread';
    // Reinitialize the pinned model on the main thread before the next frame.
    // A failure is surfaced to the caller so precise mode records a reviewable
    // frame instead of silently emitting an apparently healthy trajectory.
    void this.ensureFallback().catch(() => { this.initialized = false; });
    worker.terminate();
  }

  private disposeWorker(sendDispose = false): void {
    const worker = this.worker;
    if (!worker) {
      this.workerListener = undefined;
      this.workerErrorListener = undefined;
      return;
    }
    if (this.workerListener) worker.removeEventListener('message', this.workerListener);
    if (this.workerErrorListener) worker.removeEventListener('error', this.workerErrorListener);
    if (sendDispose) {
      try {
        worker.postMessage({ type: 'dispose', requestId: ++this.requestId } satisfies InferenceWorkerMessage);
      } catch {
        // The worker may already be terminating or failed; termination below
        // still releases its resources and is the authoritative cleanup.
      }
    }
    worker.terminate();
    this.worker = undefined;
    this.workerListener = undefined;
    this.workerErrorListener = undefined;
  }
}
