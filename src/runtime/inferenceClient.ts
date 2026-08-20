import { HandLandmarkerEngine } from './handLandmarkerEngine';
import type {
  InferenceFallbackReason,
  InferenceFrameInput,
  InferenceFrameOutput,
  InferenceInitOptions,
  InferenceInitResult,
  InferenceWorkerMessage,
  InferenceWorkerResponse,
} from './protocol';

// Re-export these types for callers that import the client as their runtime boundary.
export type { InferenceFallbackReason, InferenceInitResult } from './protocol';

type Pending = { resolve: (value: InferenceFrameOutput) => void; reject: (reason: unknown) => void };

const canTransferWorkerFrames = (): boolean =>
  typeof ImageBitmap !== 'undefined' && typeof createImageBitmap === 'function';

const isImageBitmap = (image: InferenceFrameInput['image']): image is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;

const releaseFrameInput = (image: InferenceFrameInput['image']): void => {
  const isVideoFrame = typeof VideoFrame !== 'undefined' && image instanceof VideoFrame;
  if (!isImageBitmap(image) && !isVideoFrame) return;
  try { image.close(); } catch { /* detached or already closed */ }
};

export class InferenceClient {
  private worker: Worker | undefined;
  private initializingWorker: Worker | undefined;
  private fallback: HandLandmarkerEngine | undefined;
  private initOptions: InferenceInitOptions | undefined;
  private fallbackInitPromise: Promise<void> | undefined;
  private fallbackInitToken = 0;
  private requestId = 0;
  private pending = new Map<number, Pending>();
  private busy = false;
  private initialized = false;
  private runtime: 'worker' | 'main-thread' = 'main-thread';
  private delegate: InferenceInitResult['delegate'] = 'unknown';
  private recordedFallbackReasons: InferenceFallbackReason[] = [];
  private workerListener: ((event: MessageEvent<InferenceWorkerResponse>) => void) | undefined;
  private workerErrorListener: ((event: ErrorEvent) => void) | undefined;
  private readyCancel: (() => void) | undefined;
  private lifecycle = 0;

  get executionRuntime(): 'worker' | 'main-thread' { return this.runtime; }
  get executionDelegate(): InferenceInitResult['delegate'] { return this.delegate; }
  get fallbackReason(): InferenceFallbackReason | undefined {
    const reason = this.recordedFallbackReasons.at(-1);
    return reason ? { ...reason } : undefined;
  }
  get fallbackReasons(): readonly InferenceFallbackReason[] {
    return this.recordedFallbackReasons.map((reason) => ({ ...reason }));
  }

  consumeFallbackReasons(): InferenceFallbackReason[] {
    return this.recordedFallbackReasons.splice(0);
  }

  async init(options: InferenceInitOptions): Promise<InferenceInitResult> {
    // Every init is a new inference session. MediaPipe's VIDEO mode keeps
    // temporal state inside the model instance, so reusing it across live and
    // precise sources would make timestamps and identities depend on the
    // previous source. Invalidate and tear down the old runtime synchronously
    // before any asynchronous asset/model work starts.
    const lifecycle = ++this.lifecycle;
    this.resetRuntime();
    this.initOptions = { ...options };
    // Worker inference requires an ImageBitmap transfer boundary. Browsers
    // that expose Worker but lack either the constructor or snapshot API must
    // stay on the main thread, where MediaPipe accepts the source element or
    // VideoFrame directly.
    const workerRequested = options.preferWorker !== false;
    const workerAvailable = typeof Worker !== 'undefined';
    const frameTransferAvailable = canTransferWorkerFrames();
    if (workerRequested && !workerAvailable) {
      this.recordFallback({
        code: 'worker_unavailable',
        phase: 'capability',
        message: 'Web Worker is unavailable; inference is running on the main thread.',
      });
    } else if (workerRequested && !frameTransferAvailable) {
      this.recordFallback({
        code: 'worker_frame_transfer_unavailable',
        phase: 'capability',
        message: 'ImageBitmap frame transfer is unavailable; inference is running on the main thread.',
      });
    }
    const preferWorker = workerRequested && workerAvailable && frameTransferAvailable;
    if (preferWorker) {
      let worker: Worker | undefined;
      try {
        worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
        this.initializingWorker = worker;
        const result = await this.requestReady(worker, { ...options, useModuleWasm: true });
        if (this.lifecycle !== lifecycle) {
          worker.terminate();
          throw new Error('Inference initialization superseded');
        }
        this.worker = worker;
        this.attachWorkerHandler(worker);
        this.runtime = 'worker';
        this.delegate = result.delegate;
        this.initialized = true;
        return { ...result, runtime: 'worker' };
      } catch (error) {
        // A newer init owns the client now. Do not start a fallback for this
        // stale attempt, and make sure its local worker cannot linger.
        if (worker && this.lifecycle === lifecycle) {
          try { worker.terminate(); } catch { /* already terminated */ }
        }
        if (this.lifecycle !== lifecycle) throw error;
        this.recordFallback({
          code: 'worker_initialization_failed',
          phase: 'initialization',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (worker && this.initializingWorker === worker) this.initializingWorker = undefined;
      }
    }
    if (this.lifecycle !== lifecycle) throw new Error('Inference initialization superseded');
    const result = await this.initializeFallback(options, lifecycle);
    if (this.lifecycle !== lifecycle) throw new Error('Inference initialization superseded');
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
      releaseFrameInput(input.image);
      return null;
    }
    if (this.busy) throw new Error('inference_busy_precise');
    const lifecycle = this.lifecycle;
    const requestId = ++this.requestId;
    const activeWorker = this.worker;
    let image: ImageBitmap;
    try {
      if (!canTransferWorkerFrames()) throw new Error('ImageBitmap frame transfer is unavailable');
      if (isImageBitmap(input.image)) {
        image = input.image;
      } else {
        image = await createImageBitmap(input.image);
        // createImageBitmap copies rather than consumes a VideoFrame. Once the
        // transfer bitmap exists, the source frame is no longer needed.
        releaseFrameInput(input.image);
      }
    } catch (snapshotError) {
      if (this.lifecycle !== lifecycle || this.worker !== activeWorker) {
        releaseFrameInput(input.image);
        throw new Error('Inference frame superseded');
      }
      // A decoder/browser may reject createImageBitmap for a source even
      // after worker initialization succeeded. Retire the worker and retry
      // the untouched source through the pinned main-thread engine.
      if (activeWorker) {
        const message = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
        this.handleWorkerFailure(
          activeWorker,
          new Error(`Worker frame snapshot failed: ${message}`),
          {
            code: 'worker_frame_snapshot_failed',
            phase: 'runtime',
            message,
          },
        );
      }
      try {
        await this.ensureFallback();
        if (!this.fallback) throw new Error('Inference fallback is unavailable');
        return this.fallback.process(input);
      } catch (fallbackError) {
        releaseFrameInput(input.image);
        throw fallbackError;
      }
    }
    // Snapshot creation is asynchronous. A new init/dispose may have replaced
    // the worker while it was resolving; never route an old-source frame into
    // the new MediaPipe VIDEO session.
    if (this.lifecycle !== lifecycle || this.worker !== activeWorker) {
      try { image.close(); } catch { /* detached or already closed */ }
      throw new Error('Inference frame superseded');
    }
    // The worker may fail while the source image is being prepared. Do not
    // enter the pending map after that failure: optional-chaining a missing
    // worker would leave a promise that can never settle.
    const worker = activeWorker;
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
    this.resetRuntime();
    this.initOptions = undefined;
  }

  private resetRuntime(): void {
    // requestReady is not represented in the frame pending map. Cancel it
    // explicitly so a superseded Worker init cannot leave an await hanging
    // until the 30-second timeout.
    this.readyCancel?.();
    this.readyCancel = undefined;
    const initializingWorker = this.initializingWorker;
    this.initializingWorker = undefined;
    if (initializingWorker && initializingWorker !== this.worker) {
      try { initializingWorker.terminate(); } catch { /* already terminated */ }
    }
    for (const pending of this.pending.values()) pending.reject(new Error('Inference client disposed'));
    this.pending.clear();
    this.disposeWorker(true);
    this.fallback?.close();
    this.fallback = undefined;
    this.fallbackInitToken += 1;
    this.fallbackInitPromise = undefined;
    this.initialized = false;
    this.busy = false;
    this.runtime = 'main-thread';
    this.delegate = 'unknown';
    this.recordedFallbackReasons = [];
  }

  private requestReady(worker: Worker, options: InferenceInitOptions): Promise<InferenceInitResult> {
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      let settled = false;
      let timer: number | undefined;
      const onWorkerError = (event: ErrorEvent) => settle(new Error(event.message || 'Inference worker failed to start'));
      let cancel: (() => void) | undefined;
      const settle = (error?: Error, result?: InferenceInitResult) => {
        if (settled) return;
        settled = true;
        if (this.readyCancel === cancel) this.readyCancel = undefined;
        worker.removeEventListener('message', listener);
        worker.removeEventListener('error', onWorkerError);
        if (timer !== undefined) window.clearTimeout(timer);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      cancel = () => settle(new Error('Inference initialization superseded'));
      this.readyCancel = cancel;
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

  private attachWorkerHandler(worker: Worker): void {
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
    worker.addEventListener('message', listener);
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
      this.delegate = result.delegate;
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
    const token = ++this.fallbackInitToken;
    const promise = this.initializeFallback(options, lifecycle)
      .then(() => {
        if (this.lifecycle !== lifecycle) throw new Error('Inference client disposed during fallback');
        this.runtime = 'main-thread';
        this.initialized = true;
      })
      .finally(() => {
        if (this.fallbackInitToken === token) this.fallbackInitPromise = undefined;
    });
    this.fallbackInitPromise = promise;
    try {
      await promise;
    } catch (error) {
      // A superseded fallback may reject after a newer init has already
      // installed a healthy runtime. Do not let the stale caller clobber the
      // new session's initialized flag.
      if (this.lifecycle === lifecycle && this.fallbackInitToken === token) this.initialized = false;
      throw error;
    }
  }

  private handleWorkerFailure(
    worker: Worker,
    error: Error,
    reason: InferenceFallbackReason = {
      code: 'worker_runtime_failed',
      phase: 'runtime',
      message: error.message,
    },
  ): void {
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
    this.delegate = 'unknown';
    this.recordFallback(reason);
    // Reinitialize the pinned model on the main thread before the next frame.
    // A failure is surfaced to the caller so precise mode records a reviewable
    // frame instead of silently emitting an apparently healthy trajectory.
    void this.ensureFallback().catch(() => { this.initialized = false; });
    worker.terminate();
  }

  private recordFallback(reason: InferenceFallbackReason): void {
    this.recordedFallbackReasons.push({ ...reason });
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
