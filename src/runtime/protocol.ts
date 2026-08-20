import type { RawHandCandidate } from '../core/types';

export interface InferenceFrameInput {
  frame: number;
  time: number;
  timestamp_us: number;
  width: number;
  height: number;
  image: ImageBitmap | HTMLVideoElement | VideoFrame;
  /** Set for realtime preview when stale frames may be skipped under load. */
  dropIfBusy?: boolean;
}

export interface InferenceFrameOutput {
  frame: number;
  time: number;
  timestamp_us: number;
  width: number;
  height: number;
  candidates: RawHandCandidate[];
  inferenceMs: number;
  delegate: 'GPU' | 'CPU' | 'unknown';
}

export interface InferenceInitOptions {
  modelUrl: string;
  wasmUrl: string;
  modelSha256?: string;
  wasmSha256?: string;
  wasmModuleSha256?: string;
  wasmNoSimdSha256?: string;
  /** SHA-256 of the loader JavaScript, when an asset manifest provides it. */
  wasmJsSha256?: string;
  preferWorker?: boolean;
  preferGpu?: boolean;
  /** Optional descriptive version for the pinned model asset. */
  modelVersion?: string;
  /** Hint for callers; HandLandmarker 0.10.35 exposes VIDEO only. */
  mode?: 'realtime' | 'precise';
  /** Use the ESM loader when this engine runs in a module Worker. */
  useModuleWasm?: boolean;
  /** Maximum number of queued worker frames before precise processing fails closed. */
  maxQueue?: number;
}

export interface InferenceInitResult {
  runtime: 'worker' | 'main-thread';
  delegate: 'GPU' | 'CPU' | 'unknown';
  modelVersion: string;
  modelSha256?: string;
  wasmSha256?: string;
  wasmVariant?: 'classic-simd' | 'classic-nosimd' | 'module-simd';
  liveStreamFallback: boolean;
}

export interface InferenceWorkerInitMessage {
  type: 'init';
  requestId: number;
  options: InferenceInitOptions;
}

export interface InferenceWorkerFrameMessage {
  type: 'frame';
  requestId: number;
  frame: Omit<InferenceFrameInput, 'image'>;
  image: ImageBitmap;
}

export interface InferenceWorkerDisposeMessage {
  type: 'dispose';
  requestId: number;
}

export type InferenceWorkerMessage =
  | InferenceWorkerInitMessage
  | InferenceWorkerFrameMessage
  | InferenceWorkerDisposeMessage;

export interface InferenceWorkerReadyMessage {
  type: 'ready';
  requestId: number;
  result: InferenceInitResult;
}

export interface InferenceWorkerResultMessage {
  type: 'result';
  requestId: number;
  result: InferenceFrameOutput;
}

export interface InferenceWorkerErrorMessage {
  type: 'error';
  requestId: number;
  message: string;
  code?: string;
}

export type InferenceWorkerResponse =
  | InferenceWorkerReadyMessage
  | InferenceWorkerResultMessage
  | InferenceWorkerErrorMessage;
