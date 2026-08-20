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
import type { InferenceFrameInput, InferenceFrameOutput, InferenceInitOptions, InferenceInitResult } from './protocol';

const isVideoFrame = (value: InferenceFrameInput['image']): value is VideoFrame =>
  typeof VideoFrame !== 'undefined' && value instanceof VideoFrame;

const isImageBitmap = (value: InferenceFrameInput['image']): value is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap;

const toSourcePoint = (landmark: NormalizedLandmark, width: number, height: number) => ({
  x: Math.max(0, Math.min(width, landmark.x * width)),
  y: Math.max(0, Math.min(height, landmark.y * height)),
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
  private lastTimestamp = -1;

  async init(options: InferenceInitOptions): Promise<InferenceInitResult> {
    this.options = options;
    const model = await fetchVerifiedBytes(options.modelUrl, options.modelSha256);
    const simd = await FilesetResolver.isSimdSupported();
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
    const fileset = await FilesetResolver.forVisionTasks(options.wasmUrl, useModule);
    const base = { modelAssetBuffer: model.bytes } as const;
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { ...base, delegate: options.preferGpu === false ? 'CPU' : 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.delegate = options.preferGpu === false ? 'CPU' : 'GPU';
    } catch (gpuError) {
      if (options.preferGpu === false) throw gpuError;
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { ...base, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.delegate = 'CPU';
    }
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
    };
  }

  process(input: InferenceFrameInput): InferenceFrameOutput {
    if (!this.landmarker) throw new Error('Hand landmarker is not initialized');
    const timestamp = Math.max(input.timestamp_us / 1000, this.lastTimestamp + 0.001);
    this.lastTimestamp = timestamp;
    const started = performance.now();
    const result = this.landmarker.detectForVideo(input.image, timestamp);
    if (isVideoFrame(input.image) || isImageBitmap(input.image)) input.image.close();
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
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = undefined;
    this.lastTimestamp = -1;
    this.options = undefined;
  }
}
