import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import {
  LANDMARK_NAMES,
  type RawHandCandidate,
  type RawLandmark,
} from '../core/types';
import { fetchVerifiedBytes } from './assetIntegrity';
import type {
  InferenceFallbackReason,
  InferenceFrameInput,
  InferenceFrameOutput,
  InferenceInitOptions,
  InferenceInitResult,
} from './protocol';

const isVideoFrame = (value: InferenceFrameInput['image']): value is VideoFrame =>
  typeof VideoFrame !== 'undefined' && value instanceof VideoFrame;

const isImageBitmap = (value: InferenceFrameInput['image']): value is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap;

const releaseFrameInput = (image: InferenceFrameInput['image']): void => {
  if (!isVideoFrame(image) && !isImageBitmap(image)) return;
  try { image.close(); } catch { /* detached or already closed */ }
};

const toSourcePoint = (landmark: NormalizedLandmark, width: number, height: number) => ({
  x: Math.max(0, Math.min(width, landmark.x * width)),
  y: Math.max(0, Math.min(height, landmark.y * height)),
});

// Delegate errors can contain asset URLs, local paths, or browser-specific
// implementation details. Keep provenance useful without copying that text
// into diagnostics or an exported manifest.
const safeDelegateErrorName = (error: unknown): string => {
  const name = error instanceof Error ? error.name : '';
  const allowedNames = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'DOMException',
    'AbortError',
    'InvalidStateError',
    'NotSupportedError',
    'OperationError',
  ]);
  return allowedNames.has(name) ? name : 'unknown error';
};

const gpuDelegateFallbackReason = (error: unknown): InferenceFallbackReason => ({
  code: 'gpu_delegate_unavailable',
  phase: 'initialization',
  message: `GPU delegate initialization failed (${safeDelegateErrorName(error)}); CPU delegate selected.`,
});

export function mapHandResult(result: HandLandmarkerResult, width: number, height: number): RawHandCandidate[] {
  return result.landmarks.map((landmarks, candidateIndex) => {
    const categories = result.handedness?.[candidateIndex] ?? [];
    const category = categories[0];
    const mapped: RawLandmark[] = landmarks.map((landmark, index) => ({
      index,
      name: LANDMARK_NAMES[index] ?? `landmark_${index}`,
      normalized: { x: landmark.x, y: landmark.y, z: landmark.z },
      source: toSourcePoint(landmark, width, height),
    }));
    return {
      candidateIndex,
      landmarks: mapped,
      handedness: category?.categoryName === 'Left' || category?.categoryName === 'Right' ? category.categoryName : 'Unknown',
      confidence: typeof category?.score === 'number' ? category.score : undefined,
    };
  });
}

export class HandLandmarkerEngine {
  private landmarker: HandLandmarker | undefined;
  private options: InferenceInitOptions | undefined;
  private delegate: 'GPU' | 'CPU' | 'unknown' = 'unknown';
  private fallbackReasons: InferenceFallbackReason[] = [];
  private lastTimestamp = -1;
  /**
   * Invalidates in-flight model construction when a new mode/source starts.
   * MediaPipe keeps VIDEO tracking state inside the HandLandmarker instance,
   * so an instance must never survive across independent inference sessions.
   */
  private initGeneration = 0;

  async init(options: InferenceInitOptions): Promise<InferenceInitResult> {
    const generation = ++this.initGeneration;
    this.closeCurrent();
    this.options = { ...options };
    this.delegate = 'unknown';
    this.fallbackReasons = [];
    this.lastTimestamp = -1;
    const model = await fetchVerifiedBytes(options.modelUrl, options.modelSha256);
    this.assertCurrent(generation);
    const simd = await FilesetResolver.isSimdSupported();
    this.assertCurrent(generation);
    const runningInWorker = typeof document === 'undefined';
    // The package's classic loader is injected with a script tag on the main
    // thread, while module workers require the ESM loader. If a legacy browser
    // cannot run SIMD, fail the worker init so InferenceClient can use the
    // classic main-thread path instead of attempting a broken module import.
    if (options.useModuleWasm && runningInWorker && !simd) {
      throw new Error('Worker WASM module requires SIMD; using main-thread fallback');
    }
    const useModule = options.useModuleWasm === true && simd;
    const wasmName = useModule
      ? 'vision_wasm_module_internal.wasm'
      : simd ? 'vision_wasm_internal.wasm' : 'vision_wasm_nosimd_internal.wasm';
    const wasmExpected = useModule
      ? options.wasmModuleSha256 ?? options.wasmSha256
      : simd ? options.wasmSha256 : options.wasmNoSimdSha256;
    const wasm = await fetchVerifiedBytes(`${options.wasmUrl.replace(/\/$/, '')}/${wasmName}`, wasmExpected);
    this.assertCurrent(generation);
    const fileset = await FilesetResolver.forVisionTasks(options.wasmUrl, useModule);
    this.assertCurrent(generation);
    const base = { modelAssetBuffer: model.bytes } as const;
    let created: HandLandmarker | undefined;
    let delegate: 'GPU' | 'CPU' = options.preferGpu === false ? 'CPU' : 'GPU';
    try {
      try {
        created = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { ...base, delegate: options.preferGpu === false ? 'CPU' : 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        delegate = options.preferGpu === false ? 'CPU' : 'GPU';
      } catch (gpuError) {
        if (options.preferGpu === false) throw gpuError;
        this.assertCurrent(generation);
        this.fallbackReasons.push(gpuDelegateFallbackReason(gpuError));
        created = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { ...base, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        delegate = 'CPU';
      }
      this.assertCurrent(generation);
    } catch (error) {
      if (created) {
        try { created.close(); } catch { /* best-effort cleanup */ }
      }
      throw error;
    }
    // A newer init/close may have happened while createFromOptions was
    // resolving. Do not publish a stale model into the new session.
    if (!created || this.initGeneration !== generation) {
      if (created) {
        try { created.close(); } catch { /* best-effort cleanup */ }
      }
      throw new Error('Hand landmarker initialization superseded');
    }
    this.landmarker = created;
    this.delegate = delegate;
    this.lastTimestamp = -1;
    return {
      runtime: 'main-thread',
      delegate: this.delegate,
      modelVersion: 'hand_landmarker.float16.1',
      modelSha256: model.sha256,
      wasmSha256: wasm.sha256,
      wasmVariant: useModule ? 'module-simd' : simd ? 'classic-simd' : 'classic-nosimd',
      // Tasks Vision 0.10.x exposes VIDEO for HandLandmarker; monotonic VIDEO timestamps
      // provide deterministic real-time behavior while retaining a truthful fallback flag.
      liveStreamFallback: true,
      fallbackReasons: this.fallbackReasons.length
        ? this.fallbackReasons.map((reason) => ({ ...reason }))
        : undefined,
    };
  }

  process(input: InferenceFrameInput): InferenceFrameOutput {
    // A transferred frame belongs to the engine as soon as process() is
    // called. Release it for successful inference, MediaPipe/map failures, and
    // stale calls that arrive after the engine has been closed.
    try {
      if (!this.landmarker) throw new Error('Hand landmarker is not initialized');
      const timestamp = Math.max(input.timestamp_us / 1000, this.lastTimestamp + 0.001);
      this.lastTimestamp = timestamp;
      const started = performance.now();
      const result = this.landmarker.detectForVideo(input.image, timestamp);
      return {
        frame: input.frame,
        time: input.time,
        timestamp_us: input.timestamp_us,
        width: input.width,
        height: input.height,
        candidates: mapHandResult(result, input.width, input.height),
        inferenceMs: performance.now() - started,
        delegate: this.delegate,
      };
    } finally {
      releaseFrameInput(input.image);
    }
  }

  close(): void {
    ++this.initGeneration;
    this.closeCurrent();
  }

  private closeCurrent(): void {
    try { this.landmarker?.close(); } catch { /* cleanup must remain idempotent */ }
    this.landmarker = undefined;
    this.lastTimestamp = -1;
    this.options = undefined;
    this.delegate = 'unknown';
    this.fallbackReasons = [];
  }

  private assertCurrent(generation: number): void {
    if (this.initGeneration !== generation) {
      throw new Error('Hand landmarker initialization superseded');
    }
  }
}
