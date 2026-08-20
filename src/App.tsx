import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, SyntheticEvent } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  Camera,
  Check,
  ChevronDown,
  CircleStop,
  FileVideo,
  Globe2,
  Languages,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Play,
  RotateCcw,
  ScanFace,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { CapabilityPanel } from './ui/CapabilityPanel';
import { DiagnosticsPanel } from './ui/DiagnosticsPanel';
import { ExportPanel } from './ui/ExportPanel';
import { PrivacyDialog } from './ui/PrivacyDialog';
import { StageCanvas, type ConnectionStyle, type OverlayVisualConfig, type RegionEffect } from './ui/StageCanvas';
import { TelemetryPanel } from './ui/TelemetryPanel';
import { getInitialLanguage, t } from './ui/i18n';
import type {
  AppProps,
  CapabilitySnapshot,
  CaptureMode,
  CapturePhase,
  CaptureUiActions,
  CaptureUiController,
  CaptureUiSnapshot,
  DiagnosticItem,
  Language,
  PermissionState,
  ReplayActions,
  ReplaySnapshot,
} from './ui/types';
import type { UiHand, UiPoint, OverlaySnapshot } from './ui/types';
import { CameraSession, cameraErrorMessage, isCameraSecureContext } from './runtime/cameraSession';
import { inspectVideoFile, processVideoFile, revokeVideoUrl as revokeSourceVideoUrl, startRecording as startRuntimeRecording, type LocalVideoMetadata, type RecordingController } from './runtime/videoSource';
import { InferenceClient } from './runtime/inferenceClient';
import type { InferenceInitResult } from './runtime/protocol';
import { buildExport, downloadBlob as downloadExportBlob, type BuiltExport } from './runtime/exporter';
import { renderEffectVideo } from './runtime/effectVideoExporter';
import { DiagnosticsCollector } from './runtime/diagnostics';
import { createTrajectoryStore, type TrajectoryStore } from './core/trajectoryStore';
import { buildGeometryHints } from './core/geometryHintBuilder';
import { type RawFrame, type SemanticFrame, type HandId, type FingerName } from './core/types';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;

const capability = (state: 'available' | 'unavailable' | 'unknown', detail?: string) => ({ state, detail });

export function detectCapabilities(): CapabilitySnapshot {
  if (typeof window === 'undefined') {
    return {
      secureContext: capability('unknown'),
      camera: capability('unknown'),
      workers: capability('unknown'),
      wasm: capability('unknown'),
      videoFrameCallback: capability('unknown'),
    };
  }
  const secure = isCameraSecureContext();
  const hasCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  const hasWorker = typeof Worker !== 'undefined';
  const hasWorkerFrameTransfer = typeof ImageBitmap !== 'undefined' && typeof createImageBitmap === 'function';
  const hasWorkerInference = hasWorker && hasWorkerFrameTransfer;
  const hasWasm = typeof WebAssembly !== 'undefined';
  const hasVideoClock = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  return {
    secureContext: capability(secure ? 'available' : 'unavailable', secure ? undefined : 'HTTPS required'),
    camera: capability(hasCamera ? 'available' : 'unavailable', hasCamera ? undefined : 'getUserMedia unavailable'),
    workers: capability(
      hasWorkerInference ? 'available' : 'unavailable',
      hasWorkerInference
        ? undefined
        : hasWorker
          ? 'ImageBitmap transfer is unavailable; inference will use the main thread.'
          : 'Worker is unavailable; inference will use the main thread.',
    ),
    wasm: capability(hasWasm ? 'available' : 'unavailable'),
    videoFrameCallback: capability(hasVideoClock ? 'available' : 'unknown', hasVideoClock ? undefined : 'fallback available'),
    checkedAt: Date.now(),
  };
}

const initialSource = () => ({
  kind: 'none' as const,
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  mirrored: false,
  rotation: 0 as const,
  orientationLabel: 'landscape',
});

const initialOverlay = () => ({
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  hands: [],
  semanticCount: 0 as const,
  isSample: false,
});

function initialSnapshot(language: Language): CaptureUiSnapshot {
  return {
    language,
    mode: 'live',
    phase: 'idle',
    permission: 'idle',
    capabilities: detectCapabilities(),
    source: initialSource(),
    overlay: initialOverlay(),
    metrics: {
      actualFps: undefined,
      inferenceMs: undefined,
      droppedFrames: 0,
      processedFrames: 0,
      alignment: 'unknown',
    },
    diagnostics: [],
    export: {
      standardReady: false,
      diagnosticsReady: false,
      quality: 'pending',
    },
    availableCameras: [],
    privacyOpen: false,
    modelVersion: 'Hand Landmarker · pinned',
    delegate: 'unknown',
    processProgress: undefined,
  };
}

const diagnostic = (id: string, severity: DiagnosticItem['severity'], title: string, detail?: string): DiagnosticItem => ({
  id,
  severity,
  title,
  detail,
  timestamp: Date.now(),
});

const MODEL_SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';
const WASM_SHA256 = '6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc';
const WASM_MODULE_SHA256 = '617b8e0248dbd27e9d7ece4218004eae4cefb499196d1bb4fa0e3fef21708756';
const WASM_NOSIMD_SHA256 = '8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31';

function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
}

function browserLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  return navigator.userAgent;
}

function systemLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  return navigator.platform || 'unknown';
}

function modelInitializationErrorMessage(error: unknown): string {
  const detail = error instanceof Error && error.message.trim()
    ? error.message
    : 'Unknown Hand Landmarker initialization error.';
  return `Hand Landmarker model initialization failed: ${detail}`;
}

function uiPoint(side: HandId, finger: FingerName, x: number, y: number, width: number, height: number, interpolated = false): UiPoint {
  return { side, finger, x, y, nx: width > 0 ? x / width : undefined, ny: height > 0 ? y / height : undefined, interpolated };
}

function buildOverlay(frames: readonly SemanticFrame[], width: number, height: number, sourceFrame?: number, sourceTime?: number, smooth = false): OverlaySnapshot {
  let current = frames.at(-1);
  if (frames.length > 0 && (sourceFrame !== undefined || sourceTime !== undefined)) {
    const target = sourceTime ?? sourceFrame ?? 0;
    let low = 0;
    let high = frames.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const value = sourceTime !== undefined ? frames[mid].time : frames[mid].frame;
      if (value <= target) low = mid;
      else high = mid - 1;
    }
    current = frames[low];
  }
  if (!current) return { width, height, hands: [], semanticCount: 0, isSample: false, sourceFrame, sourceTime };
  const bySide = new Map<HandId, UiHand>();
  const semanticById = new Map(current.extendedPoints.map((point) => [`${point.side}:${point.finger}`, point]));
  const recent = frames.slice(-45);
  for (const side of ['hand_1', 'hand_2'] as HandId[]) {
    const palm = current.palms.find((item) => item.side === side);
    const points: UiPoint[] = [];
    for (const finger of ['thumb', 'index', 'middle', 'ring', 'little'] as FingerName[]) {
      const point = semanticById.get(`${side}:${finger}`);
      if (!point) continue;
      const trail = recent.flatMap((frame) => frame.extendedPoints.filter((item) => item.side === side && item.finger === finger).map((item) => ({ x: item.x, y: item.y, nx: width > 0 ? item.x / width : undefined, ny: height > 0 ? item.y / height : undefined })));
      let displayPoint = point;
      const isFastPinchRelease = (finger === 'thumb' || finger === 'index')
        && point.compressed === false
        && point.releaseBlend !== undefined
        && point.releaseBlend < 1;
      if (smooth && !isFastPinchRelease) {
        const prior = recent
          .slice(0, -1)
          .slice(-4)
          .reverse()
          .map((frame, index) => ({ point: frame.extendedPoints.find((item) => item.side === side && item.finger === finger), weight: 0.32 ** (index + 1) }))
          .filter((entry): entry is { point: typeof point; weight: number } => Boolean(entry.point));
        const weight = prior.reduce((sum, entry) => sum + entry.weight, 0);
        if (weight > 0) {
          displayPoint = {
            ...point,
            x: (point.x + prior.reduce((sum, entry) => sum + entry.point.x * entry.weight, 0)) / (1 + weight),
            y: (point.y + prior.reduce((sum, entry) => sum + entry.point.y * entry.weight, 0)) / (1 + weight),
          };
        }
      }
      points.push({ ...uiPoint(side, finger, displayPoint.x, displayPoint.y, width, height, current.flags.interpolated), trail });
    }
    if (palm || points.length > 0) {
      const palmTrail = recent.flatMap((frame) => frame.palms.filter((item) => item.side === side && item.visible).map((item) => ({ x: item.x, y: item.y, nx: width > 0 ? item.x / width : undefined, ny: height > 0 ? item.y / height : undefined })));
      bySide.set(side, {
        side,
        state: current.state,
        palm: palm ? uiPoint(side, 'middle', palm.x, palm.y, width, height) : undefined,
        scale: palm?.scale,
        orientation: palm?.orientation,
        points,
        trail: palmTrail,
        confidence: undefined,
      });
    }
  }
  return { width, height, hands: [...bySide.values()], semanticCount: current.count, isSample: false, sourceFrame: sourceFrame ?? current.frame, sourceTime: sourceTime ?? current.time };
}

export function useLocalCaptureController(initialLanguage?: Language): CaptureUiController & {
  videoRef: RefObject<HTMLVideoElement>;
  updateVideoMetadata: (metadata: { width: number; height: number; duration?: number }) => void;
} {
  const [snapshot, setSnapshot] = useState<CaptureUiSnapshot>(() => initialSnapshot(initialLanguage ?? getInitialLanguage()));
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | undefined>();
  const [effectVideoBusy, setEffectVideoBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraSession | null>(null);
  const inferenceRef = useRef<InferenceClient | null>(null);
  const inferenceInitRef = useRef<InferenceInitResult | null>(null);
  const inferenceInitPromiseRef = useRef<Promise<InferenceInitResult> | null>(null);
  const inferenceModeRef = useRef<'realtime' | 'precise' | undefined>();
  const inferenceGenerationRef = useRef(0);
  const trajectoryRef = useRef<TrajectoryStore>(createTrajectoryStore({ maxFrames: 60 * 60 * 60 }));
  const diagnosticsRef = useRef<DiagnosticsCollector>(new DiagnosticsCollector());
  const recordingRef = useRef<RecordingController | null>(null);
  // Starting a recording may wait for camera permission/model setup. A newer
  // mode, source, camera, or recording request must make that continuation a
  // no-op before it can create a MediaRecorder for the wrong stream.
  const recordingStartGenerationRef = useRef(0);
  const sourceMetadataRef = useRef<LocalVideoMetadata | undefined>();
  // Guards asynchronous metadata/hash inspection when users replace a source
  // before the previous file or recording has finished loading.
  const sourceGenerationRef = useRef(0);
  const exportRef = useRef<BuiltExport | null>(null);
  const processingAbortRef = useRef<AbortController | null>(null);
  // A separate run generation protects the shared trajectory/export refs from
  // callbacks that were already in flight when a precise run was cancelled or
  // replaced. Inference generation only scopes the model instance, not the
  // source-processing transaction.
  const processingGenerationRef = useRef(0);
  const liveBusyRef = useRef(false);
  // A camera frame can still be resolving after the stream or inference
  // client has been replaced. Keep its ownership explicit so late results
  // cannot mutate a newer session or clear its busy flag.
  const liveGenerationRef = useRef(0);
  const liveInFlightRef = useRef<{ generation: number; client: InferenceClient; session: CameraSession } | null>(null);
  const cameraRequestGenerationRef = useRef(0);
  const liveFrameRef = useRef(0);
  const liveWindowRef = useRef({ startedAt: 0, frames: 0 });
  const capabilityDiagnosticsRef = useRef<DiagnosticItem[]>([]);
  const replayFramesRef = useRef<SemanticFrame[]>([]);
  const replayRef = useRef<ReplaySnapshot>({ ready: false, currentTime: 0, duration: 0, playing: false });
  const modeRef = useRef<CaptureMode>(snapshot.mode);
  modeRef.current = snapshot.mode;
  const patchSnapshot = useCallback((patch: Partial<CaptureUiSnapshot> | ((current: CaptureUiSnapshot) => Partial<CaptureUiSnapshot>)) => {
    setSnapshot((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  }, []);

  const replayFlags = useCallback((frame?: SemanticFrame): string[] => {
    if (!frame) return [];
    const flags: string[] = [];
    if (frame.flags.identityAmbiguous) flags.push('identity_ambiguous');
    if (frame.flags.needsReview) flags.push('needs_review');
    if (frame.flags.interpolated) flags.push('interpolated');
    if (frame.flags.longGap) flags.push('long_gap');
    if (frame.flags.identityReset?.length) flags.push('identity_reset');
    if (frame.flags.errors?.length) flags.push('errors');
    return flags;
  }, []);

  const updateReplayAtTime = useCallback((time: number) => {
    const frames = replayFramesRef.current;
    const duration = replayRef.current.duration;
    const clamped = Math.min(Math.max(Number.isFinite(time) ? time : 0, 0), duration || Number.MAX_SAFE_INTEGER);
    const current = frames.length ? (() => {
      let low = 0; let high = frames.length - 1;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (frames[mid].time <= clamped) low = mid; else high = mid - 1; }
      return frames[low];
    })() : undefined;
    replayRef.current = { ...replayRef.current, currentTime: clamped, currentFrame: current?.frame, flags: replayFlags(current) };
    patchSnapshot({ overlay: current ? buildOverlay(frames, current.width, current.height, current.frame, current.time) : initialOverlay(), replay: replayRef.current });
  }, [patchSnapshot, replayFlags]);

  const playReplay = useCallback(async () => {
    const video = videoRef.current;
    if (!replayRef.current.ready || !video) return;
    try { await video.play(); } catch { return; }
    replayRef.current = { ...replayRef.current, playing: true };
    patchSnapshot({ replay: replayRef.current });
  }, [patchSnapshot]);

  const pauseReplay = useCallback(() => {
    videoRef.current?.pause();
    replayRef.current = { ...replayRef.current, playing: false };
    patchSnapshot({ replay: replayRef.current });
  }, [patchSnapshot]);

  const seekReplay = useCallback((time: number) => {
    if (!replayRef.current.ready) return;
    const next = Math.min(Math.max(time, 0), replayRef.current.duration);
    if (videoRef.current) videoRef.current.currentTime = next;
    updateReplayAtTime(next);
  }, [updateReplayAtTime]);

  const restartReplay = useCallback(async () => {
    seekReplay(0);
    await playReplay();
  }, [playReplay, seekReplay]);

  const stepReplay = useCallback((direction: -1 | 1) => {
    const frames = replayFramesRef.current;
    if (!frames.length) return;
    const currentIndex = Math.max(0, frames.findIndex((frame) => frame.frame === replayRef.current.currentFrame));
    const next = frames[Math.min(frames.length - 1, Math.max(0, currentIndex + direction))];
    pauseReplay();
    seekReplay(next.time);
  }, [pauseReplay, seekReplay]);

  const replayActions: ReplayActions = useMemo(() => ({ playReplay, pauseReplay, restartReplay, seekReplay, stepReplay }), [pauseReplay, playReplay, restartReplay, seekReplay, stepReplay]);

  const publishDiagnostics = useCallback(() => {
    const events = diagnosticsRef.current.snapshot().events;
    const runtimeDiagnostics: DiagnosticItem[] = events.map((event) => ({
      id: event.id,
      severity: event.severity,
      title: event.message,
      detail: event.frame === undefined ? undefined : `frame ${event.frame}${event.time === undefined ? '' : ` · ${event.time.toFixed(3)}s`}`,
      timestamp: Date.now(),
    }));
    patchSnapshot({ diagnostics: [...capabilityDiagnosticsRef.current, ...runtimeDiagnostics] });
  }, [patchSnapshot]);

  const addDiagnostic = useCallback((event: { code: string; severity: 'info' | 'warning' | 'error'; message: string; frame?: number; time?: number; details?: Record<string, unknown> }) => {
    diagnosticsRef.current.add(event);
    publishDiagnostics();
  }, [publishDiagnostics]);

  // Inference can move from a Worker/GPU to the main-thread/CPU after the
  // initial handshake. Consume those reasons at the controller boundary so
  // the UI and the exported diagnostics package describe the actual path.
  const syncInferenceProvenance = useCallback((client: InferenceClient, fallbackDelegate: InferenceInitResult['delegate'] = 'unknown', frame?: number, time?: number) => {
    const actualDelegate = client.executionDelegate ?? fallbackDelegate;
    patchSnapshot({ delegate: actualDelegate });
    for (const reason of client.consumeFallbackReasons?.() ?? []) {
      addDiagnostic({
        code: reason.code,
        severity: reason.phase === 'runtime' ? 'error' : 'warning',
        message: reason.message,
        frame,
        time,
        details: { phase: reason.phase, runtime: client.executionRuntime },
      });
    }
    return actualDelegate;
  }, [addDiagnostic, patchSnapshot]);

  const invalidateLive = useCallback(() => {
    liveGenerationRef.current += 1;
    liveBusyRef.current = false;
    liveInFlightRef.current = null;
  }, []);

  const invalidateRecordingStart = useCallback(() => {
    recordingStartGenerationRef.current += 1;
  }, []);

  const stopCamera = useCallback(() => {
    invalidateRecordingStart();
    cameraRequestGenerationRef.current += 1;
    invalidateLive();
    cameraRef.current?.stop();
    cameraRef.current = null;
    setVideoStream(null);
  }, [invalidateLive, invalidateRecordingStart]);

  const handleInferenceInitializationError = useCallback((error: unknown) => {
    // Model setup happens after camera permission has succeeded. Keep that
    // distinction visible to the user and do not turn a model/WASM failure
    // into a misleading camera-permission diagnostic.
    const message = modelInitializationErrorMessage(error);
    cameraRef.current?.stopFrames();
    stopCamera();
    patchSnapshot((current) => ({
      permission: 'granted',
      phase: 'error',
      errorMessage: message,
      export: { ...current.export, standardReady: false, diagnosticsReady: false, quality: 'error' },
    }));
  }, [patchSnapshot, stopCamera]);

  const revokeVideoUrl = useCallback(() => {
    revokeSourceVideoUrl(sourceMetadataRef.current);
    sourceMetadataRef.current = undefined;
    setVideoUrl(undefined);
  }, []);

  const invalidateProcessing = useCallback(() => {
    // Increment before aborting so synchronous abort listeners and already
    // resolved callbacks observe the stale generation immediately.
    processingGenerationRef.current += 1;
    const abort = processingAbortRef.current;
    processingAbortRef.current = null;
    abort?.abort();
  }, []);

  const enumerateCameras = useCallback(async () => {
    const session = cameraRef.current;
    if (!session) return;
    try {
      const availableCameras = await session.enumerateCameras();
      patchSnapshot({ availableCameras });
    } catch {
      addDiagnostic({ code: 'device_enumeration', severity: 'info', message: 'Camera list unavailable.' });
    }
  }, [addDiagnostic, patchSnapshot]);

  const checkCapabilities = useCallback(() => {
    const capabilities = detectCapabilities();
    const issues: DiagnosticItem[] = [];
    if (capabilities.secureContext.state === 'unavailable') issues.push(diagnostic('secure-context', 'error', 'HTTPS is required', 'Open the deployed site over HTTPS or use localhost.'));
    if (capabilities.camera.state === 'unavailable') issues.push(diagnostic('camera-api', 'error', 'Camera API unavailable', 'Choose precise mode and import a local video instead.'));
    capabilityDiagnosticsRef.current = issues;
    patchSnapshot({ capabilities, diagnostics: issues, phase: 'ready', errorMessage: undefined });
  }, [patchSnapshot]);

  const ensureInference = useCallback(async (mode: 'realtime' | 'precise', forceReset = false): Promise<InferenceInitResult> => {
    const sameMode = inferenceModeRef.current === mode;
    if (!forceReset && sameMode && inferenceInitRef.current && inferenceRef.current) return inferenceInitRef.current;
    if (!forceReset && sameMode && inferenceInitPromiseRef.current) return inferenceInitPromiseRef.current;

    const generation = ++inferenceGenerationRef.current;
    const client = inferenceRef.current ?? new InferenceClient();
    // A mode change or a new precise source must start with a fresh
    // HandLandmarker VIDEO state. InferenceClient.dispose() also cancels any
    // in-flight initialization before the replacement starts.
    if (inferenceRef.current && (forceReset || !sameMode)) client.dispose();
    inferenceRef.current = client;
    inferenceInitRef.current = null;
    inferenceModeRef.current = mode;
    const promise = client.init({
      modelUrl: assetUrl('models/hand_landmarker.task'),
      wasmUrl: assetUrl('wasm'),
      modelSha256: MODEL_SHA256,
      wasmSha256: WASM_SHA256,
      wasmModuleSha256: WASM_MODULE_SHA256,
      wasmNoSimdSha256: WASM_NOSIMD_SHA256,
      preferWorker: detectCapabilities().workers.state === 'available',
      preferGpu: true,
      mode,
    }).then((result) => {
      if (inferenceGenerationRef.current !== generation || inferenceRef.current !== client || inferenceModeRef.current !== mode) {
        throw new Error('Inference initialization superseded');
      }
      inferenceInitRef.current = result;
      const actualDelegate = syncInferenceProvenance(client, result.delegate);
      patchSnapshot({ modelVersion: result.modelVersion, delegate: actualDelegate });
      return result;
    }).catch((error) => {
      if (inferenceGenerationRef.current === generation && inferenceRef.current === client) {
        client.dispose();
        inferenceRef.current = null;
        inferenceInitRef.current = null;
        inferenceModeRef.current = undefined;
        const message = error instanceof Error ? error.message : 'Hand model initialization failed.';
        addDiagnostic({ code: 'model_init', severity: 'error', message });
      }
      throw error;
    }).finally(() => {
      if (inferenceInitPromiseRef.current === promise) inferenceInitPromiseRef.current = null;
    });
    inferenceInitPromiseRef.current = promise;
    return promise;
  }, [addDiagnostic, patchSnapshot, syncInferenceProvenance]);

  const appendOutput = useCallback((
    output: { frame: number; time: number; timestamp_us: number; width: number; height: number; candidates: RawFrame['hands']; inferenceMs: number; delegate: 'GPU' | 'CPU' | 'unknown' },
    dropped = false,
    errors?: string[],
    failClosed = false,
  ) => {
    const raw: RawFrame = {
      frame: output.frame,
      time: output.time,
      timestamp_us: output.timestamp_us,
      width: output.width,
      height: output.height,
      hands: dropped ? [] : output.candidates,
      flags: dropped ? { dropped: true, needsReview: true, errors } : errors?.length ? { needsReview: true, errors } : undefined,
    };
    let semantic: SemanticFrame | undefined;
    try {
      semantic = trajectoryRef.current.appendRawFrame(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Trajectory store rejected a frame.';
      const reachedLimit = message.startsWith('trajectory_store_limit:');
      const publicMessage = reachedLimit
        ? 'Trajectory storage capacity was reached. Capture stopped because the partial result cannot be exported and needs review.'
        : message;
      raw.flags = { ...raw.flags, needsReview: true, errors: [...(raw.flags?.errors ?? []), message] };
      addDiagnostic({ code: reachedLimit ? 'trajectory_store_limit' : 'trajectory_store', severity: 'error', message: publicMessage, frame: raw.frame, time: raw.time });
      if (reachedLimit) {
        exportRef.current = null;
        if (failClosed) throw (error instanceof Error ? error : new Error(message));
        cameraRef.current?.stopFrames();
        invalidateLive();
        patchSnapshot((current) => ({
          phase: 'error',
          errorMessage: publicMessage,
          export: { ...current.export, standardReady: false, diagnosticsReady: false, quality: 'error' },
        }));
      }
    }
    diagnosticsRef.current.recordInference(output.inferenceMs, dropped);
    diagnosticsRef.current.ingestRaw(raw);
    if (semantic) diagnosticsRef.current.ingestSemantic(semantic);
    patchSnapshot((current) => ({
      overlay: semantic ? buildOverlay(trajectoryRef.current.getSemanticFrames(), output.width, output.height, output.frame, output.time, inferenceModeRef.current === 'realtime') : current.overlay,
      metrics: {
        ...current.metrics,
        inferenceMs: output.inferenceMs,
        processedFrames: trajectoryRef.current.getRawFrames().length,
        actualFps: current.metrics.actualFps,
      },
      delegate: output.delegate,
    }));
    publishDiagnostics();
    return semantic;
  }, [addDiagnostic, invalidateLive, patchSnapshot, publishDiagnostics]);

  const handleLiveFrame = useCallback(async (
    frame: { image: HTMLVideoElement; mediaTime: number; presentedFrames?: number; width: number; height: number },
    generation: number,
    session: CameraSession,
  ) => {
    if (generation !== liveGenerationRef.current || cameraRef.current !== session || inferenceModeRef.current !== 'realtime') return;
    if (liveBusyRef.current) {
      diagnosticsRef.current.recordInference(0, true);
      patchSnapshot((current) => ({ metrics: { ...current.metrics, droppedFrames: current.metrics.droppedFrames + 1 } }));
      return;
    }
    const client = inferenceRef.current;
    const init = inferenceInitRef.current;
    if (!client || !init) return;
    const token = { generation, client, session };
    liveBusyRef.current = true;
    liveInFlightRef.current = token;
    const isCurrent = () => liveInFlightRef.current === token
      && generation === liveGenerationRef.current
      && cameraRef.current === session
      && inferenceRef.current === client
      && inferenceModeRef.current === 'realtime';
    const now = performance.now();
    if (!liveWindowRef.current.startedAt) liveWindowRef.current.startedAt = now;
    liveWindowRef.current.frames += 1;
    const frameNumber = typeof frame.presentedFrames === 'number' ? Math.max(0, frame.presentedFrames - 1) : liveFrameRef.current;
    liveFrameRef.current = Math.max(liveFrameRef.current + 1, frameNumber + 1);
    const width = frame.width || videoRef.current?.videoWidth || DEFAULT_WIDTH;
    const height = frame.height || videoRef.current?.videoHeight || DEFAULT_HEIGHT;
    const timestamp_us = Math.round(frame.mediaTime * 1_000_000);
    try {
      const output = await client.process({
        frame: frameNumber,
        time: frame.mediaTime,
        timestamp_us,
        width,
        height,
        image: frame.image,
      });
      if (!isCurrent()) return;
      const actualDelegate = syncInferenceProvenance(client, init.delegate, frameNumber, frame.mediaTime);
      if (!output) {
        appendOutput({ frame: frameNumber, time: frame.mediaTime, timestamp_us, width, height, candidates: [], inferenceMs: 0, delegate: actualDelegate }, true);
      } else {
        appendOutput({ ...output, delegate: actualDelegate });
      }
      const elapsed = performance.now() - liveWindowRef.current.startedAt;
      if (elapsed >= 1000 && isCurrent()) {
        const actualFps = liveWindowRef.current.frames * 1000 / elapsed;
        liveWindowRef.current = { startedAt: performance.now(), frames: 0 };
        patchSnapshot((current) => ({ metrics: { ...current.metrics, actualFps } }));
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : 'Live inference failed.';
      const actualDelegate = syncInferenceProvenance(client, init.delegate, frameNumber, frame.mediaTime);
      appendOutput({ frame: frameNumber, time: frame.mediaTime, timestamp_us, width, height, candidates: [], inferenceMs: 0, delegate: actualDelegate }, true, [message]);
      addDiagnostic({ code: 'live_inference', severity: 'error', message, frame: frameNumber, time: frame.mediaTime });
    } finally {
      if (liveInFlightRef.current === token) {
        liveInFlightRef.current = null;
        liveBusyRef.current = false;
      }
    }
  }, [addDiagnostic, appendOutput, patchSnapshot, syncInferenceProvenance]);

  const resetLiveCaptureState = useCallback((width = snapshot.source.width, height = snapshot.source.height) => {
    invalidateLive();
    trajectoryRef.current.clear();
    replayFramesRef.current = [];
    replayRef.current = { ready: false, currentTime: 0, duration: 0, playing: false };
    diagnosticsRef.current.clear();
    exportRef.current = null;
    liveFrameRef.current = 0;
    liveWindowRef.current = { startedAt: performance.now(), frames: 0 };
    patchSnapshot((current) => ({
      overlay: {
        ...initialOverlay(),
        width,
        height,
      },
      metrics: {
        ...current.metrics,
        actualFps: undefined,
        inferenceMs: undefined,
        droppedFrames: 0,
        processedFrames: 0,
        totalFrames: undefined,
        alignment: 'presentation_time_estimate',
      },
      export: { standardReady: false, diagnosticsReady: false, quality: 'pending' },
      errorMessage: undefined,
    }));
    publishDiagnostics();
  }, [invalidateLive, patchSnapshot, publishDiagnostics, snapshot.source.height, snapshot.source.width]);

  const startLiveFrames = useCallback(() => {
    const session = cameraRef.current;
    if (!session) return;
    // Session state is reset before model initialization. Keeping this method
    // limited to frame-loop startup prevents it from erasing initialization
    // provenance (for example, a GPU/Worker fallback) just recorded by the
    // inference client.
    const generation = liveGenerationRef.current;
    session.startFrames((frame) => { void handleLiveFrame(frame, generation, session); });
  }, [handleLiveFrame]);

  const requestCamera = useCallback(async (cameraIdOverride?: string, recordingStartGeneration?: number) => {
    if (recordingStartGeneration === undefined) invalidateRecordingStart();
    else if (recordingStartGenerationRef.current !== recordingStartGeneration) return;
    // Switching back to a live source invalidates any precise callbacks that
    // may still be waiting on inference or decoder events.
    invalidateProcessing();
    invalidateLive();
    const requestGeneration = ++cameraRequestGenerationRef.current;
    const capabilities = detectCapabilities();
    if (capabilities.secureContext.state === 'unavailable') {
      patchSnapshot({ permission: 'unsupported', phase: 'error', errorMessage: 'Secure context required', diagnostics: [diagnostic('secure-context', 'error', 'HTTPS is required', 'Camera access is blocked on insecure origins.')] });
      return;
    }
    if (capabilities.camera.state !== 'available') {
      patchSnapshot({ permission: 'unsupported', phase: 'error', errorMessage: 'Camera API unavailable', diagnostics: [diagnostic('camera-api', 'error', 'Camera API unavailable')] });
      return;
    }
    patchSnapshot({ permission: 'checking', phase: 'loading-model', errorMessage: undefined });
    let session: CameraSession | undefined;
    const isCurrentRequest = () => cameraRequestGenerationRef.current === requestGeneration
      && cameraRef.current === session;
    const source = snapshot.source;
    if (source.kind === 'file' || source.kind === 'recording') revokeVideoUrl();

    // Camera acquisition, playback, and track setup have their own error
    // boundary. Only failures in this section are classified as camera or
    // permission errors.
    let activeSession: CameraSession;
    let metadata: Awaited<ReturnType<CameraSession['request']>>;
    try {
      session = cameraRef.current ?? new CameraSession(videoRef.current ?? undefined);
      cameraRef.current = session;
      activeSession = session;
      activeSession.setCallbacks({
        onEnded: () => {
          if (cameraRef.current !== activeSession) return;
          invalidateProcessing();
          invalidateLive();
          ++sourceGenerationRef.current;
          const recorder = recordingRef.current;
          recordingRef.current = null;
          if (recorder) void recorder.stop().catch(() => undefined);
          stopCamera();
          addDiagnostic({
            code: 'camera_track_ended',
            severity: 'error',
            message: 'The camera track ended unexpectedly; capture was stopped and the session needs review.',
          });
          patchSnapshot({ phase: 'error', permission: 'granted', errorMessage: 'Camera track ended unexpectedly.' });
        },
      });
      // StageCanvas owns the visible mirror transform; keep the camera source untransformed
      // so the overlay and video cannot be mirrored twice.
      activeSession.setMirror(false);
      metadata = await activeSession.request(cameraIdOverride ?? snapshot.selectedCameraId);
      if (!isCurrentRequest()) return;
      setVideoStream(activeSession.mediaStream ?? null);
    } catch (error) {
      if (!isCurrentRequest()) return;
      const name = error instanceof DOMException ? error.name : 'UnknownError';
      const detail = cameraErrorMessage(error);
      const permission: PermissionState = name === 'NotAllowedError' ? 'denied' : 'unsupported';
      stopCamera();
      const permissionDiagnostic = diagnostic('permission', name === 'NotAllowedError' ? 'warning' : 'error', 'Camera could not start', detail);
      patchSnapshot((current) => ({
        permission,
        phase: 'error',
        errorMessage: detail,
        diagnostics: [...current.diagnostics.filter((item) => item.id !== permissionDiagnostic.id), permissionDiagnostic],
      }));
      return;
    }

    const width = metadata.width || DEFAULT_WIDTH;
    const height = metadata.height || DEFAULT_HEIGHT;
    resetLiveCaptureState(width, height);
    let init: InferenceInitResult;
    try {
      init = await ensureInference('realtime');
    } catch (error) {
      if (!isCurrentRequest()) return;
      handleInferenceInitializationError(error);
      return;
    }
    if (!isCurrentRequest() || inferenceModeRef.current !== 'realtime') return;
    const client = inferenceRef.current;
    const actualDelegate = client
      ? syncInferenceProvenance(client, init.delegate)
      : init.delegate;
    patchSnapshot((current) => ({
      permission: 'granted',
      phase: 'preview',
      mode: 'live',
      source: { ...current.source, kind: 'camera', mirrored: current.source.kind === 'camera' ? current.source.mirrored : true, width, height, fps: metadata.frameRate ?? DEFAULT_FPS, name: 'camera', duration: undefined, rotation: 0, orientationLabel: width >= height ? 'landscape' : 'portrait' },
      overlay: { ...current.overlay, width, height, hands: [], semanticCount: 0 },
      metrics: { ...current.metrics, alignment: 'presentation_time_estimate' },
      diagnostics: current.diagnostics.filter((item) => !['secure-context', 'camera-api', 'permission'].includes(item.id)),
      modelVersion: init.modelVersion,
      delegate: actualDelegate,
    }));
    await enumerateCameras();
    if (!isCurrentRequest()) return;
    startLiveFrames();
  }, [ensureInference, enumerateCameras, handleInferenceInitializationError, invalidateLive, invalidateProcessing, invalidateRecordingStart, patchSnapshot, resetLiveCaptureState, revokeVideoUrl, snapshot.selectedCameraId, snapshot.source, startLiveFrames, stopCamera, syncInferenceProvenance]);

  const startPreview = useCallback(async () => {
    invalidateRecordingStart();
    if (cameraRef.current?.mediaStream) {
      const session = cameraRef.current;
      const requestGeneration = cameraRequestGenerationRef.current;
      resetLiveCaptureState();
      let init: InferenceInitResult;
      try {
        init = await ensureInference('realtime');
      } catch (error) {
        if (cameraRef.current !== session || cameraRequestGenerationRef.current !== requestGeneration) return;
        handleInferenceInitializationError(error);
        return;
      }
      if (cameraRef.current !== session || cameraRequestGenerationRef.current !== requestGeneration || inferenceModeRef.current !== 'realtime') return;
      const client = inferenceRef.current;
      if (!client) return;
      const actualDelegate = syncInferenceProvenance(client, init.delegate);
      patchSnapshot({ mode: 'live', phase: 'preview', errorMessage: undefined, delegate: actualDelegate });
      startLiveFrames();
      return;
    }
    await requestCamera();
  }, [ensureInference, handleInferenceInitializationError, invalidateRecordingStart, patchSnapshot, requestCamera, resetLiveCaptureState, startLiveFrames, syncInferenceProvenance]);

  const startRecording = useCallback(async () => {
    if (recordingRef.current || modeRef.current !== 'live') return;
    const recordingStartGeneration = ++recordingStartGenerationRef.current;
    try {
      if (!cameraRef.current?.mediaStream) await requestCamera(undefined, recordingStartGeneration);
      if (recordingStartGenerationRef.current !== recordingStartGeneration || modeRef.current !== 'live' || recordingRef.current) return;
      const session = cameraRef.current;
      const stream = session?.mediaStream;
      if (!stream) throw new Error('Camera stream is unavailable.');
      if (cameraRef.current !== session || session.mediaStream !== stream) return;
      const recorder = startRuntimeRecording(stream);
      if (recordingStartGenerationRef.current !== recordingStartGeneration || modeRef.current !== 'live' || cameraRef.current !== session || session.mediaStream !== stream) {
        void recorder.stop().catch(() => undefined);
        return;
      }
      recordingRef.current = recorder;
      patchSnapshot({ mode: 'live', phase: 'recording', errorMessage: undefined });
    } catch (error) {
      if (recordingStartGenerationRef.current !== recordingStartGeneration || modeRef.current !== 'live') return;
      const message = error instanceof Error ? error.message : 'Recording failed.';
      addDiagnostic({ code: 'recorder', severity: 'error', message });
      patchSnapshot({ phase: 'error', errorMessage: message });
    }
  }, [addDiagnostic, patchSnapshot, requestCamera]);

  const stopRecording = useCallback(async () => {
    invalidateRecordingStart();
    invalidateProcessing();
    // Stop accepting live frames as soon as the user ends the capture. The
    // recorder may take a task or two to flush its final chunk, but those
    // frames must not leak into the precise source that is being prepared.
    invalidateLive();
    cameraRef.current?.stopFrames();
    const sourceGeneration = ++sourceGenerationRef.current;
    const recorder = recordingRef.current;
    recordingRef.current = null;
    if (!recorder) return;
    try {
      const blob = await recorder.stop();
      // Release the camera before metadata inspection so a stalled decoder or
      // a replacement source cannot keep the device open indefinitely.
      if (sourceGenerationRef.current === sourceGeneration) stopCamera();
      const file = new File([blob], 'capture.webm', { type: blob.type || recorder.mimeType || 'video/webm' });
      const metadata = await inspectVideoFile(file);
      if (sourceGenerationRef.current !== sourceGeneration) {
        revokeSourceVideoUrl(metadata);
        return;
      }
      metadata.fps = snapshot.source.fps ?? DEFAULT_FPS;
      revokeVideoUrl();
      sourceMetadataRef.current = metadata;
      setVideoUrl(metadata.url);
      stopCamera();
      patchSnapshot((current) => ({
        mode: 'precise',
        phase: 'ready',
        source: { ...current.source, kind: 'recording', name: 'capture.webm', width: metadata.width, height: metadata.height, duration: metadata.duration, fps: metadata.fps },
        overlay: { ...current.overlay, width: metadata.width, height: metadata.height, hands: [], semanticCount: 0 },
        metrics: { ...current.metrics, alignment: 'unknown', processedFrames: 0, totalFrames: undefined, droppedFrames: 0 },
        export: { ...current.export, standardReady: false, diagnosticsReady: false, quality: 'pending' },
        errorMessage: undefined,
      }));
    } catch (error) {
      if (sourceGenerationRef.current !== sourceGeneration) return;
      stopCamera();
      const message = error instanceof Error ? error.message : 'Recording could not be prepared for precise processing.';
      addDiagnostic({ code: 'recording_prepare', severity: 'error', message });
      patchSnapshot({ phase: 'error', errorMessage: message });
    }
  }, [addDiagnostic, invalidateLive, invalidateProcessing, invalidateRecordingStart, patchSnapshot, revokeVideoUrl, snapshot.source.fps, stopCamera]);

  const importVideo = useCallback(async (file: File) => {
    invalidateRecordingStart();
    invalidateProcessing();
    const sourceGeneration = ++sourceGenerationRef.current;
    modeRef.current = 'precise';
    const recorder = recordingRef.current;
    recordingRef.current = null;
    if (recorder) void recorder.stop().catch(() => undefined);
    revokeVideoUrl();
    stopCamera();
    trajectoryRef.current.clear();
    replayFramesRef.current = [];
    replayRef.current = { ready: false, currentTime: 0, duration: 0, playing: false };
    diagnosticsRef.current.clear();
    exportRef.current = null;
    patchSnapshot((current) => ({
      mode: 'precise',
      phase: 'checking',
      source: { ...initialSource(), mirrored: true },
      overlay: initialOverlay(),
      metrics: {
        ...current.metrics,
        actualFps: undefined,
        inferenceMs: undefined,
        alignment: 'unknown',
        processedFrames: 0,
        totalFrames: undefined,
        droppedFrames: 0,
      },
      export: { standardReady: false, diagnosticsReady: false, quality: 'pending' },
      diagnostics: capabilityDiagnosticsRef.current,
      processProgress: undefined,
      errorMessage: undefined,
    }));
    if (!file.type.startsWith('video/') && !/\.(webm|mp4|m4v|mov|ogv)$/i.test(file.name)) {
      patchSnapshot({ phase: 'error', errorMessage: 'Unsupported video file', diagnostics: [diagnostic('decode', 'error', 'Unsupported video file', 'Choose a browser-decodable WebM or H.264 MP4.')] });
      return;
    }
    try {
      const metadata = await inspectVideoFile(file);
      if (sourceGenerationRef.current !== sourceGeneration) {
        revokeSourceVideoUrl(metadata);
        return;
      }
      sourceMetadataRef.current = metadata;
      setVideoUrl(metadata.url);
      patchSnapshot((current) => ({
        mode: 'precise',
        phase: 'ready',
        permission: current.permission === 'granted' ? current.permission : 'idle',
        source: { ...current.source, kind: 'file', name: metadata.name, width: metadata.width, height: metadata.height, duration: metadata.duration, fps: metadata.fps },
        overlay: { ...current.overlay, width: metadata.width, height: metadata.height, hands: [], semanticCount: 0, isSample: false },
        metrics: { ...current.metrics, alignment: 'unknown', processedFrames: 0, totalFrames: undefined, droppedFrames: 0 },
        export: { ...current.export, standardReady: false, diagnosticsReady: false, quality: 'pending' },
        diagnostics: capabilityDiagnosticsRef.current,
        errorMessage: undefined,
      }));
    } catch (error) {
      if (sourceGenerationRef.current !== sourceGeneration) return;
      const message = error instanceof Error ? error.message : 'Video could not be decoded.';
      addDiagnostic({ code: 'decode', severity: 'error', message });
      patchSnapshot({
        phase: 'error',
        errorMessage: message,
        export: { standardReady: false, diagnosticsReady: false, quality: 'error' },
      });
    }
  }, [addDiagnostic, invalidateProcessing, invalidateRecordingStart, patchSnapshot, revokeVideoUrl, stopCamera]);

  const processSource = useCallback(async () => {
    const metadata = sourceMetadataRef.current;
    if (!metadata || (snapshot.source.kind !== 'file' && snapshot.source.kind !== 'recording')) return;
    const sourceSnapshot = {
      metadata,
      kind: snapshot.source.kind,
      mirrored: snapshot.source.mirrored,
      rotation: snapshot.source.rotation,
      orientationLabel: snapshot.source.orientationLabel ?? 'identity',
    } as const;
    invalidateProcessing();
    const sourceGeneration = ++sourceGenerationRef.current;
    const generation = processingGenerationRef.current;
    const abort = new AbortController();
    processingAbortRef.current = abort;
    // `isCurrentRun` deliberately checks controller identity as well as the
    // monotonic generation. A cancelled run must not clear or overwrite the
    // controller belonging to a newer source.
    const isCurrentRun = () => processingGenerationRef.current === generation && processingAbortRef.current === abort;
    const isWritable = () => isCurrentRun()
      && !abort.signal.aborted
      && sourceGenerationRef.current === sourceGeneration
      && sourceMetadataRef.current === sourceSnapshot.metadata;
    trajectoryRef.current.clear();
    diagnosticsRef.current.clear();
    exportRef.current = null;
    publishDiagnostics();
    patchSnapshot({ phase: 'processing', processProgress: 0, errorMessage: undefined, metrics: { ...snapshot.metrics, processedFrames: 0, totalFrames: undefined, droppedFrames: 0, alignment: 'unknown' }, export: { ...snapshot.export, standardReady: false, diagnosticsReady: false, quality: 'pending' } });
    try {
      // Rebuild for every precise source, even when the previous source was
      // also precise, so MediaPipe VIDEO tracking state cannot leak between
      // files or a prior live preview.
      const init = await ensureInference('precise', true);
      if (!isWritable()) return;
      const client = inferenceRef.current;
      if (!client) throw new Error('Inference client is unavailable.');
      let processedFrames = 0;
      let totalFrames: number | undefined;
      const processResult = await processVideoFile(metadata, {
        signal: abort.signal,
        onProgress: ({ frame, processedFrames: reportedProcessed, sourceFrames, estimatedTotalFrames }) => {
          if (!isWritable()) return;
          processedFrames = reportedProcessed;
          totalFrames = estimatedTotalFrames ?? totalFrames;
          const progress = totalFrames ? Math.min(100, (sourceFrames / totalFrames) * 100) : undefined;
          patchSnapshot((current) => ({
            processProgress: progress,
            metrics: { ...current.metrics, processedFrames, totalFrames, actualFps: current.metrics.actualFps },
          }));
          if (frame === 0 || processedFrames % 30 === 0) publishDiagnostics();
        },
        onDecodeGap: (gap) => {
          if (!isWritable()) return;
          appendOutput({
            frame: gap.frame,
            time: gap.mediaTime,
            timestamp_us: gap.timestampUs,
            width: metadata.width,
            height: metadata.height,
            candidates: [],
            inferenceMs: 0,
            delegate: syncInferenceProvenance(client, undefined, gap.frame, gap.mediaTime),
          }, true, [gap.reason], true);
          if (!isWritable()) return;
          const rawFrames = trajectoryRef.current.getRawFrames();
          const raw = rawFrames.at(-1);
          if (raw?.frame === gap.frame) raw.flags = { ...raw.flags, decodeGap: true, needsReview: true };
          diagnosticsRef.current.add({
            code: 'decode_gap',
            severity: 'warning',
            message: 'Source frame was not presented by the browser decoder.',
            frame: gap.frame,
            time: gap.mediaTime,
          });
        },
        onFrame: async (frame) => {
          if (!isWritable()) return;
          let output;
          try {
            // Keep the client bound to this run. Looking it up from the ref
            // after an await can route a late callback into a replacement
            // source's model instance.
            output = await client.process({ frame: frame.frame, time: frame.mediaTime, timestamp_us: frame.timestampUs, width: metadata.width, height: metadata.height, image: frame.image });
          } catch (error) {
            if (!isWritable()) return;
            const message = error instanceof Error ? error.message : 'Precise inference failed.';
            const actualDelegate = syncInferenceProvenance(client, undefined, frame.frame, frame.mediaTime);
            appendOutput({ frame: frame.frame, time: frame.mediaTime, timestamp_us: frame.timestampUs, width: metadata.width, height: metadata.height, candidates: [], inferenceMs: 0, delegate: actualDelegate }, true, [message], true);
            return;
          }
          if (!isWritable()) return;
          const actualDelegate = syncInferenceProvenance(client, undefined, frame.frame, frame.mediaTime);
          if (!output) {
            appendOutput({ frame: frame.frame, time: frame.mediaTime, timestamp_us: frame.timestampUs, width: metadata.width, height: metadata.height, candidates: [], inferenceMs: 0, delegate: actualDelegate }, true, ['Inference returned no frame.'], true);
            return;
          }
          appendOutput({ ...output, delegate: actualDelegate }, false, undefined, true);
        },
      });
      if (!isWritable()) return;
      const alignmentNeedsReview = processResult.alignment !== 'exact_source_frames' || processResult.method === 'seek-estimate';
      if (alignmentNeedsReview) {
        diagnosticsRef.current.add({
          code: 'alignment_estimate',
          severity: 'warning',
          message: 'Frame timing was estimated from presentation or seek timing; reprocess with exact source-frame decoding before final compositing.',
          details: { alignment: processResult.alignment, method: processResult.method },
        });
      }
      const semanticFrames = [...trajectoryRef.current.getSemanticFrames()];
      replayFramesRef.current = semanticFrames;
      const rawFrames = [...trajectoryRef.current.getRawFrames()];
      const summary = trajectoryRef.current.summary();
      const actualDelegate = syncInferenceProvenance(client);
      const actualRuntime = client.executionRuntime ?? init.runtime;
      const diagnostics = diagnosticsRef.current.snapshot();
      const built = buildExport({
        appVersion: '0.1.0',
        modelName: 'MediaPipe Hand Landmarker',
        modelVersion: init.modelVersion,
        modelSha256: init.modelSha256 ?? MODEL_SHA256,
        wasmSha256: init.wasmSha256 ?? WASM_SHA256,
        captureMode: 'precise',
        alignment: processResult.alignment,
        source: { name: metadata.name, width: metadata.width, height: metadata.height, fps: processResult.derivedFps ?? metadata.fps, durationSeconds: metadata.duration, timebase: '1/1000000', sha256: metadata.sha256 },
        // Preview mirroring is a display transform only. Raw landmarks and
        // exported source coordinates always remain in unmirrored source space.
        mirror: false,
        rotationDegrees: sourceSnapshot.rotation,
        orientationTransform: sourceSnapshot.orientationLabel,
        inferenceWidth: metadata.width,
        inferenceHeight: metadata.height,
        delegate: actualDelegate,
        diagnostics: { ...diagnostics.quality, summary, inference_runtime: actualRuntime, inference_delegate: actualDelegate },
        transitions: { count: summary.transitions.length, events: summary.transitions },
        sourceFrameCount: processResult.sourceFrameCount,
        derivedFps: processResult.derivedFps,
        diagnosticEvents: diagnostics.events,
      }, semanticFrames, rawFrames, buildGeometryHints(semanticFrames), {
        fingertipSeries: trajectoryRef.current.fingertipSeries(),
        palmSeries: trajectoryRef.current.palmSeries(),
      });
      if (!isWritable()) return;
      exportRef.current = built;
      // Export-level quality also includes geometry validation. Keep the UI
      // status aligned with the package manifest so an invalid portal hint
      // cannot be presented as ready for compositing.
      const quality = alignmentNeedsReview
        || built.bundle.quality?.needs_review === true
        || diagnostics.quality.needs_review
        || summary.needsReviewFrames > 0
        || summary.identityAmbiguousFrames > 0
        ? 'needs_review'
        : 'ready';
      patchSnapshot({
        phase: 'complete',
        processProgress: 100,
        metrics: { ...snapshot.metrics, processedFrames, totalFrames: processResult.sourceFrameCount, alignment: processResult.alignment, droppedFrames: summary.droppedFrames },
        export: { standardReady: true, diagnosticsReady: true, quality, fileName: built.standardFileName.replace(/\.zip$/, ''), sizeBytes: built.standardBlob.size, generatedAt: Date.now() },
        replay: {
          ready: true,
          currentTime: 0,
          duration: metadata.duration || semanticFrames.at(-1)?.time || 0,
          currentFrame: semanticFrames[0]?.frame,
          totalFrames: processResult.sourceFrameCount,
          playing: false,
          flags: replayFlags(semanticFrames[0]),
        },
      });
      replayRef.current = {
        ready: true,
        currentTime: 0,
        duration: metadata.duration || semanticFrames.at(-1)?.time || 0,
        currentFrame: semanticFrames[0]?.frame,
        totalFrames: processResult.sourceFrameCount,
        playing: false,
        flags: replayFlags(semanticFrames[0]),
      };
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
      updateReplayAtTime(0);
      publishDiagnostics();
    } catch (error) {
      if (!isCurrentRun()) return;
      if (abort.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        patchSnapshot({ phase: 'ready', processProgress: undefined });
        return;
      }
      const message = error instanceof Error ? error.message : 'Precise processing failed.';
      const reachedLimit = message.startsWith('trajectory_store_limit:');
      const publicMessage = reachedLimit
        ? 'Trajectory storage capacity was reached before all source frames were processed. The partial result cannot be exported and needs review.'
        : message;
      if (!reachedLimit) addDiagnostic({ code: 'processing', severity: 'error', message: publicMessage });
      exportRef.current = null;
      patchSnapshot({
        phase: 'error',
        errorMessage: publicMessage,
        processProgress: undefined,
        export: { standardReady: false, diagnosticsReady: false, quality: 'error' },
      });
    } finally {
      if (isCurrentRun()) processingAbortRef.current = null;
    }
  }, [addDiagnostic, appendOutput, ensureInference, invalidateProcessing, patchSnapshot, processVideoFile, publishDiagnostics, replayFlags, snapshot.export, snapshot.metrics, snapshot.source, updateReplayAtTime]);

  const cancelProcessing = useCallback(() => {
    invalidateProcessing();
    invalidateRecordingStart();
    ++sourceGenerationRef.current;
    patchSnapshot({ phase: 'ready', processProgress: undefined });
  }, [invalidateProcessing, invalidateRecordingStart, patchSnapshot]);

  const clearSession = useCallback(() => {
    invalidateRecordingStart();
    invalidateProcessing();
    ++sourceGenerationRef.current;
    const recorder = recordingRef.current;
    recordingRef.current = null;
    if (recorder) void recorder.stop().catch(() => undefined);
    stopCamera();
    ++inferenceGenerationRef.current;
    revokeVideoUrl();
    inferenceRef.current?.dispose();
    inferenceRef.current = null;
    inferenceInitRef.current = null;
    inferenceInitPromiseRef.current = null;
    inferenceModeRef.current = undefined;
    diagnosticsRef.current.clear();
    trajectoryRef.current.clear();
    replayFramesRef.current = [];
    replayRef.current = { ready: false, currentTime: 0, duration: 0, playing: false };
    exportRef.current = null;
    modeRef.current = 'live';
    setSnapshot(initialSnapshot(snapshot.language));
  }, [invalidateProcessing, invalidateRecordingStart, revokeVideoUrl, snapshot.language, stopCamera]);

  const toggleMirror = useCallback(() => {
    patchSnapshot((current) => {
      const mirrored = !current.source.mirrored;
      cameraRef.current?.setMirror(false);
      return { source: { ...current.source, mirrored } };
    });
  }, [patchSnapshot]);

  const selectCamera = useCallback(async (cameraId: string) => {
    invalidateRecordingStart();
    patchSnapshot({ selectedCameraId: cameraId });
    if (recordingRef.current) {
      // A MediaRecorder cannot be retargeted to a new track safely. Finalize
      // the current local recording and leave the selected device queued for
      // the next live session.
      await stopRecording();
      return;
    }
    if (cameraRef.current?.mediaStream) {
      await requestCamera(cameraId);
    }
  }, [invalidateRecordingStart, patchSnapshot, requestCamera, stopRecording]);

  const setMode = useCallback((mode: CaptureMode) => {
    if (mode === snapshot.mode) return;
    modeRef.current = mode;
    // A live recording is already the best precise-mode source. Finalize it
    // through the normal metadata/hash path instead of dropping the blob.
    if (mode === 'precise' && recordingRef.current) {
      invalidateRecordingStart();
      patchSnapshot({ mode: 'precise', phase: 'checking', errorMessage: undefined });
      void stopRecording();
      return;
    }
    invalidateProcessing();
    invalidateRecordingStart();
    ++sourceGenerationRef.current;
    invalidateLive();
    const recorder = recordingRef.current;
    recordingRef.current = null;
    if (recorder) {
      // This branch is defensive for a recorder that outlives the live mode;
      // never leave a MediaRecorder rejection as an unhandled promise.
      void recorder.stop().catch((error) => {
        const message = error instanceof Error ? error.message : 'Recording could not be stopped.';
        addDiagnostic({ code: 'recorder_stop', severity: 'warning', message });
      });
    }
    stopCamera();
    ++inferenceGenerationRef.current;
    inferenceRef.current?.dispose();
    inferenceRef.current = null;
    inferenceInitRef.current = null;
    inferenceInitPromiseRef.current = null;
    inferenceModeRef.current = undefined;
    revokeVideoUrl();
    trajectoryRef.current.clear();
    replayFramesRef.current = [];
    replayRef.current = { ready: false, currentTime: 0, duration: 0, playing: false };
    diagnosticsRef.current.clear();
    exportRef.current = null;
    patchSnapshot((current) => ({
      mode,
      phase: 'ready',
      source: { ...initialSource(), mirrored: false },
      overlay: initialOverlay(),
      metrics: {
        ...current.metrics,
        actualFps: undefined,
        inferenceMs: undefined,
        droppedFrames: 0,
        processedFrames: 0,
        totalFrames: undefined,
        alignment: mode === 'live' ? 'presentation_time_estimate' : 'unknown',
      },
      diagnostics: capabilityDiagnosticsRef.current,
      export: { standardReady: false, diagnosticsReady: false, quality: 'pending' },
      processProgress: undefined,
      errorMessage: undefined,
    }));
  }, [addDiagnostic, invalidateLive, invalidateProcessing, invalidateRecordingStart, patchSnapshot, revokeVideoUrl, snapshot.mode, stopCamera, stopRecording]);

  const setLanguage = useCallback((language: Language) => {
    patchSnapshot({ language });
  }, [patchSnapshot]);

  const setPrivacyOpen = useCallback((privacyOpen: boolean) => {
    patchSnapshot({ privacyOpen });
  }, [patchSnapshot]);

  const updateVideoMetadata = useCallback((metadata: { width: number; height: number; duration?: number }) => {
    patchSnapshot((current) => ({
      source: {
        ...current.source,
        width: metadata.width || current.source.width,
        height: metadata.height || current.source.height,
        duration: metadata.duration,
      },
      overlay: { ...current.overlay, width: metadata.width || current.overlay.width, height: metadata.height || current.overlay.height },
    }));
  }, [patchSnapshot]);

  const downloadStandard = useCallback(() => {
    const built = exportRef.current;
    if (!built) return;
    downloadExportBlob(built.standardBlob, built.standardFileName);
  }, []);

  const downloadDiagnostics = useCallback(() => {
    const built = exportRef.current;
    if (!built) return;
    downloadExportBlob(built.diagnosticsBlob, built.diagnosticsFileName);
  }, []);

  const downloadEffectVideo = useCallback(async (effects: readonly string[]) => {
    const metadata = sourceMetadataRef.current;
    const frames = replayFramesRef.current;
    if (!metadata?.url || !frames.length || effectVideoBusy) return;
    setEffectVideoBusy(true);
    try {
      const blob = await renderEffectVideo({
        sourceUrl: metadata.url,
        frames,
        width: metadata.width,
        height: metadata.height,
        effects: effects as Parameters<typeof renderEffectVideo>[0]['effects'],
      });
      downloadExportBlob(blob, `parallel-universe-effect-video-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
    } catch (error) {
      patchSnapshot({ errorMessage: error instanceof Error ? error.message : 'Effect video export failed.' });
    } finally {
      setEffectVideoBusy(false);
    }
  }, [effectVideoBusy, patchSnapshot]);

  useEffect(() => {
    checkCapabilities();
    return () => {
      invalidateProcessing();
      invalidateLive();
      ++sourceGenerationRef.current;
      const recorder = recordingRef.current;
      recordingRef.current = null;
      if (recorder) void recorder.stop().catch(() => undefined);
      cameraRef.current?.stop();
      cameraRef.current = null;
      ++inferenceGenerationRef.current;
      inferenceRef.current?.dispose();
      inferenceRef.current = null;
      inferenceInitPromiseRef.current = null;
      inferenceInitRef.current = null;
      inferenceModeRef.current = undefined;
      revokeSourceVideoUrl(sourceMetadataRef.current);
      sourceMetadataRef.current = undefined;
    };
  }, [checkCapabilities, invalidateProcessing]);

  const actions: CaptureUiActions = useMemo(() => ({
    checkCapabilities,
    requestCamera,
    startPreview,
    startRecording,
    stopRecording,
    processSource,
    cancelProcessing,
    importVideo,
    clearSession,
    toggleMirror,
    selectCamera,
    setMode,
    setLanguage,
    setPrivacyOpen,
    downloadStandard,
    downloadDiagnostics,
    downloadEffectVideo,
    playReplay,
    pauseReplay,
    restartReplay,
    seekReplay,
    stepReplay,
  }), [cancelProcessing, checkCapabilities, clearSession, downloadDiagnostics, downloadEffectVideo, downloadStandard, importVideo, processSource, requestCamera, selectCamera, setLanguage, setMode, setPrivacyOpen, startPreview, startRecording, stopRecording, toggleMirror]);

  return { snapshot, actions, videoStream, videoUrl, videoRef, updateVideoMetadata, replay: snapshot.replay, replayActions, onReplayTime: updateReplayAtTime, effectVideoBusy };
}

export default function App({ controller: externalController, initialLanguage }: AppProps) {
  const localController = useLocalCaptureController(initialLanguage);
  const controller = externalController ?? localController;
  const { snapshot, actions } = controller;
  const videoRef = controller.videoRef ?? localController.videoRef;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(true);
  const [visualConfig, setVisualConfig] = useState<OverlayVisualConfig>({ connections: ['portal'], effects: ['aurora'] });
  const lang = snapshot.language;
  const isProcessing = snapshot.phase === 'processing';
  const isLive = snapshot.mode === 'live';
  const hasSource = snapshot.source.kind !== 'none';
  const canProcess = snapshot.mode === 'precise' && (snapshot.source.kind === 'file' || snapshot.source.kind === 'recording');
  const statusLabel = snapshot.phase === 'loading-model' ? t(lang, 'loadingModel') : snapshot.phase === 'error' ? t(lang, 'failed') : t(lang, snapshot.phase as never);

  const handleVideoMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (!Number.isFinite(video.videoWidth) || video.videoWidth <= 0) return;
    const duration = Number.isFinite(video.duration) ? video.duration : undefined;
    // External controllers own their source metadata; this callback is only a local-shell fallback.
    if (!externalController) {
      localController.updateVideoMetadata({ width: video.videoWidth, height: video.videoHeight, duration });
    }
  }, [externalController, localController]);

  const openFilePicker = () => fileInputRef.current?.click();
  const toggleVisual = (kind: 'connections' | 'effects', value: ConnectionStyle | RegionEffect) => setVisualConfig((current) => {
    const values = current[kind] as string[];
    const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
    return { ...current, [kind]: next } as OverlayVisualConfig;
  });

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="." aria-label={t(lang, 'appName')}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-copy"><span className="brand-eyebrow">{t(lang, 'eyebrow')}</span><strong>{t(lang, 'appName')}</strong></span>
        </a>
        <div className="topbar-actions">
          <span className="local-chip"><span className="status-dot" />{t(lang, 'localOnly')}</span>
          <button type="button" className="topbar-button" onClick={() => actions.setPrivacyOpen(true)} aria-label={t(lang, 'privacy')}><LockKeyhole size={15} /><span>{t(lang, 'privacy')}</span></button>
          <button type="button" className="topbar-button language-button" onClick={() => actions.setLanguage(lang === 'zh' ? 'en' : 'zh')} aria-label={t(lang, 'languageLabel')}><Languages size={15} /><span>{t(lang, 'language')}</span></button>
          <button type="button" className="mobile-menu-button" onClick={() => setMobileMenuOpen((open) => !open)} aria-label={lang === 'zh' ? '打开控制' : 'Open controls'} aria-expanded={mobileMenuOpen}><Menu size={18} /></button>
        </div>
      </header>

      <main className="app-main">
        <section className="intro-row">
          <div className="intro-copy">
            <span className="section-kicker">VECTOR FRAME / 01</span>
            <h1>{t(lang, 'subtitle')}</h1>
          </div>
          <div className="intro-status" role="status" aria-live="polite">
            <span className={`status-orb phase-${snapshot.phase}`}><span /></span>
            <span><small>{lang === 'zh' ? '会话状态' : 'SESSION STATUS'}</small><strong>{statusLabel}</strong></span>
            {snapshot.errorMessage ? <AlertCircle size={16} aria-label={snapshot.errorMessage} /> : <Check size={16} />}
          </div>
        </section>

        <section className="mode-bar" aria-labelledby="mode-title">
          <div className="mode-label"><SlidersHorizontal size={15} /><span id="mode-title">{t(lang, 'chooseMode')}</span></div>
          <div className="mode-switch" role="tablist" aria-label={t(lang, 'chooseMode')}>
            <button type="button" className={isLive ? 'is-active' : ''} role="tab" aria-selected={isLive} onClick={() => actions.setMode('live')}><Video size={16} /><span>{t(lang, 'live')}</span><small>{t(lang, 'liveDescription')}</small></button>
            <button type="button" className={!isLive ? 'is-active' : ''} role="tab" aria-selected={!isLive} onClick={() => actions.setMode('precise')}><ScanFace size={16} /><span>{t(lang, 'precise')}</span><small>{t(lang, 'preciseDescription')}</small></button>
          </div>
        </section>

        <div className={`workspace-grid ${mobileMenuOpen ? 'mobile-controls-open' : ''}`}>
          <aside className="left-rail">
            <CapabilityPanel language={lang} capabilities={snapshot.capabilities} onCheck={actions.checkCapabilities} />
            <section className="control-panel" aria-labelledby="control-title">
              <div className="section-heading compact">
                <div><span className="section-kicker">01 / INPUT</span><h2 id="control-title">{lang === 'zh' ? '输入控制' : 'Input controls'}</h2></div>
                <Settings2 size={15} aria-hidden="true" />
              </div>
              <div className="control-stack">
                {isLive ? (
                  <>
                    <button type="button" className="action-button primary" onClick={actions.startPreview} disabled={snapshot.phase === 'loading-model' || snapshot.phase === 'recording'}><Camera size={17} /><span>{snapshot.permission === 'granted' ? t(lang, 'startPreview') : t(lang, 'grantCamera')}</span><ArrowUpRight size={15} /></button>
                    {snapshot.permission !== 'granted' ? <small className="control-hint">{t(lang, 'permissionHint')}</small> : null}
                    <button type="button" className={`action-button ${snapshot.phase === 'recording' ? 'danger' : ''}`} onClick={snapshot.phase === 'recording' ? actions.stopRecording : actions.startRecording} disabled={snapshot.permission !== 'granted' && snapshot.phase !== 'preview'}>{snapshot.phase === 'recording' ? <CircleStop size={17} /> : <Video size={17} />}<span>{snapshot.phase === 'recording' ? t(lang, 'stopRecording') : t(lang, 'startRecording')}</span></button>
                  </>
                ) : (
                  <>
                    <button type="button" className="action-button primary" onClick={openFilePicker}><Upload size={17} /><span>{t(lang, 'importVideo')}</span><ArrowUpRight size={15} /></button>
                    <input ref={fileInputRef} className="visually-hidden" type="file" accept="video/webm,video/mp4,video/quicktime,video/ogg,.webm,.mp4,.mov,.ogv" aria-label={t(lang, 'hiddenInputLabel')} onChange={(event) => { const file = event.target.files?.[0]; if (file) void actions.importVideo(file); event.target.value = ''; }} />
                    <div className="processing-action">
                      <button type="button" className="action-button" onClick={canProcess ? actions.processSource : openFilePicker} disabled={isProcessing || !hasSource}>{isProcessing ? <LoaderCircle className="spin" size={17} /> : <FileVideo size={17} />}<span>{isProcessing ? `${t(lang, 'processing')} ${snapshot.processProgress ?? 0}%` : t(lang, 'process')}</span></button>
                      {isProcessing ? <button type="button" className="inline-cancel" onClick={actions.cancelProcessing} aria-label={t(lang, 'cancel')} title={t(lang, 'cancel')}><X size={14} /></button> : null}
                    </div>
                    {isProcessing ? <div className="progress-track"><span style={{ width: `${snapshot.processProgress ?? 0}%` }} /></div> : null}
                  </>
                )}
                <div className="control-divider" />
                {snapshot.availableCameras.length > 0 ? <label className="select-control"><span>{t(lang, 'cameraSelect')}</span><span className="select-wrap"><select value={snapshot.selectedCameraId ?? snapshot.availableCameras[0]?.id ?? ''} onChange={(event) => void actions.selectCamera(event.target.value)}>{snapshot.availableCameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></span></label> : <div className="no-camera-note"><Camera size={14} /><span>{snapshot.permission === 'granted' ? t(lang, 'noCamera') : t(lang, 'noPermission')}</span></div>}
                <button type="button" className="toggle-control" onClick={actions.toggleMirror} aria-pressed={snapshot.source.mirrored}><span className={`toggle-track ${snapshot.source.mirrored ? 'is-on' : ''}`}><span /></span><span>{t(lang, 'mirror')}</span><small>{snapshot.source.mirrored ? t(lang, 'yes') : t(lang, 'no')}</small></button>
                <button type="button" className="clear-button" onClick={actions.clearSession}><Trash2 size={15} /><span>{t(lang, 'clear')}</span></button>
              </div>
            </section>
          </aside>

          <div className="center-stage">
            <StageCanvas language={lang} source={snapshot.source} overlay={snapshot.overlay} phase={snapshot.phase} mirror={snapshot.source.mirrored} videoStream={controller.videoStream} videoUrl={controller.videoUrl} videoRef={videoRef} onVideoMetadata={handleVideoMetadata} onVideoError={() => actions.setPrivacyOpen(false)} replay={controller.replay ?? snapshot.replay} replayActions={{ playReplay: actions.playReplay ?? (() => undefined), pauseReplay: actions.pauseReplay ?? (() => undefined), restartReplay: actions.restartReplay ?? (() => undefined), seekReplay: actions.seekReplay ?? (() => undefined), stepReplay: actions.stepReplay ?? (() => undefined), ...controller.replayActions }} onReplayTime={controller.onReplayTime} visualConfig={visualConfig} onVisualConfigChange={toggleVisual} />
            <div className="stage-legend" aria-label={lang === 'zh' ? '叠加层图例' : 'Overlay legend'}>
              <span><i className="legend-swatch swatch-palm" />{lang === 'zh' ? '掌心 / 方向' : 'Palm / orientation'}</span>
              <span><i className="legend-swatch swatch-h1" />{t(lang, 'hand1')}</span>
              <span><i className="legend-swatch swatch-h2" />{t(lang, 'hand2')}</span>
              <span><i className="legend-swatch swatch-trail" />{lang === 'zh' ? '轨迹' : 'Trail'}</span>
            </div>
          </div>

          <aside className="right-rail">
            <TelemetryPanel language={lang} metrics={snapshot.metrics} source={snapshot.source} mode={snapshot.mode} />
            <DiagnosticsPanel language={lang} diagnostics={snapshot.diagnostics} />
            <ExportPanel language={lang} exportState={snapshot.export} onStandard={actions.downloadStandard} onDiagnostics={actions.downloadDiagnostics} onEffectVideo={actions.downloadEffectVideo ? () => actions.downloadEffectVideo?.(visualConfig.effects) : undefined} effectVideoReady={snapshot.phase === 'complete' && snapshot.export.standardReady && Boolean(controller.videoUrl)} effectVideoBusy={controller.effectVideoBusy} />
          </aside>
        </div>
      </main>

      <footer className="app-footer">
        <span><ShieldCheck size={14} />{t(lang, 'secureNote')}</span>
        <span>{snapshot.modelVersion ?? 'Hand Landmarker'} · {snapshot.delegate ?? 'unknown'}</span>
        <button type="button" className="footer-link" onClick={() => actions.setPrivacyOpen(true)}>{t(lang, 'privacy')} <ArrowUpRight size={13} /></button>
      </footer>
      <PrivacyDialog language={lang} open={snapshot.privacyOpen} onClose={() => actions.setPrivacyOpen(false)} />
      <div className="sr-live" aria-live="polite">{snapshot.errorMessage ?? (snapshot.phase === 'processing' ? `${t(lang, 'processing')} ${snapshot.processProgress ?? 0}%` : '')}</div>
    </div>
  );
}
