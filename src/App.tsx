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
import { StageCanvas } from './ui/StageCanvas';
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
} from './ui/types';
import type { UiHand, UiPoint, OverlaySnapshot } from './ui/types';
import { CameraSession, cameraErrorMessage } from './runtime/cameraSession';
import { inspectVideoFile, processVideoFile, revokeVideoUrl as revokeSourceVideoUrl, startRecording as startRuntimeRecording, type LocalVideoMetadata, type RecordingController } from './runtime/videoSource';
import { InferenceClient } from './runtime/inferenceClient';
import type { InferenceInitResult } from './runtime/protocol';
import { buildExport, downloadBlob as downloadExportBlob, type BuiltExport } from './runtime/exporter';
import { DiagnosticsCollector } from './runtime/diagnostics';
import { createTrajectoryStore, type TrajectoryStore } from './core/trajectoryStore';
import { buildGeometryHints } from './core/geometryHintBuilder';
import { type RawFrame, type SemanticFrame, type HandId, type FingerName } from './core/types';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;

const capability = (state: 'available' | 'unavailable' | 'unknown', detail?: string) => ({ state, detail });

function detectCapabilities(): CapabilitySnapshot {
  if (typeof window === 'undefined') {
    return {
      secureContext: capability('unknown'),
      camera: capability('unknown'),
      workers: capability('unknown'),
      wasm: capability('unknown'),
      videoFrameCallback: capability('unknown'),
    };
  }
  const hostname = window.location.hostname;
  const secure = window.isSecureContext || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const hasCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  const hasWorker = typeof Worker !== 'undefined';
  const hasWasm = typeof WebAssembly !== 'undefined';
  const hasVideoClock = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  return {
    secureContext: capability(secure ? 'available' : 'unavailable', secure ? undefined : 'HTTPS required'),
    camera: capability(hasCamera ? 'available' : 'unavailable', hasCamera ? undefined : 'getUserMedia unavailable'),
    workers: capability(hasWorker ? 'available' : 'unavailable'),
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

function uiPoint(side: HandId, finger: FingerName, x: number, y: number, width: number, height: number, interpolated = false): UiPoint {
  return { side, finger, x, y, nx: width > 0 ? x / width : undefined, ny: height > 0 ? y / height : undefined, interpolated };
}

function buildOverlay(frames: readonly SemanticFrame[], width: number, height: number, sourceFrame?: number, sourceTime?: number): OverlaySnapshot {
  const current = frames.at(-1);
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
      points.push({ ...uiPoint(side, finger, point.x, point.y, width, height, current.flags.interpolated), trail });
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

function useLocalCaptureController(initialLanguage?: Language): CaptureUiController & {
  videoRef: RefObject<HTMLVideoElement>;
  updateVideoMetadata: (metadata: { width: number; height: number; duration?: number }) => void;
} {
  const [snapshot, setSnapshot] = useState<CaptureUiSnapshot>(() => initialSnapshot(initialLanguage ?? getInitialLanguage()));
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | undefined>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraSession | null>(null);
  const inferenceRef = useRef<InferenceClient | null>(null);
  const inferenceInitRef = useRef<InferenceInitResult | null>(null);
  const inferenceInitPromiseRef = useRef<Promise<InferenceInitResult> | null>(null);
  const trajectoryRef = useRef<TrajectoryStore>(createTrajectoryStore({ maxFrames: 60 * 60 * 60 }));
  const diagnosticsRef = useRef<DiagnosticsCollector>(new DiagnosticsCollector());
  const recordingRef = useRef<RecordingController | null>(null);
  const sourceMetadataRef = useRef<LocalVideoMetadata | undefined>();
  const exportRef = useRef<BuiltExport | null>(null);
  const processingAbortRef = useRef<AbortController | null>(null);
  const liveBusyRef = useRef(false);
  const liveFrameRef = useRef(0);
  const liveWindowRef = useRef({ startedAt: 0, frames: 0 });
  const capabilityDiagnosticsRef = useRef<DiagnosticItem[]>([]);

  const patchSnapshot = useCallback((patch: Partial<CaptureUiSnapshot> | ((current: CaptureUiSnapshot) => Partial<CaptureUiSnapshot>)) => {
    setSnapshot((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  }, []);

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

  const stopCamera = useCallback(() => {
    cameraRef.current?.stop();
    cameraRef.current = null;
    liveBusyRef.current = false;
    setVideoStream(null);
  }, []);

  const revokeVideoUrl = useCallback(() => {
    revokeSourceVideoUrl(sourceMetadataRef.current);
    sourceMetadataRef.current = undefined;
    setVideoUrl(undefined);
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

  const ensureInference = useCallback(async (): Promise<InferenceInitResult> => {
    if (inferenceInitRef.current && inferenceRef.current) return inferenceInitRef.current;
    if (inferenceInitPromiseRef.current) return inferenceInitPromiseRef.current;
    const client = inferenceRef.current ?? new InferenceClient();
    inferenceRef.current = client;
    const promise = client.init({
      modelUrl: assetUrl('models/hand_landmarker.task'),
      wasmUrl: assetUrl('wasm'),
      modelSha256: MODEL_SHA256,
      wasmSha256: WASM_SHA256,
      wasmModuleSha256: WASM_MODULE_SHA256,
      wasmNoSimdSha256: WASM_NOSIMD_SHA256,
      preferWorker: detectCapabilities().workers.state === 'available',
      preferGpu: true,
    }).then((result) => {
      inferenceInitRef.current = result;
      patchSnapshot({ modelVersion: result.modelVersion, delegate: result.delegate });
      return result;
    }).catch((error) => {
      client.dispose();
      inferenceRef.current = null;
      const message = error instanceof Error ? error.message : 'Hand model initialization failed.';
      addDiagnostic({ code: 'model_init', severity: 'error', message });
      throw error;
    }).finally(() => {
      inferenceInitPromiseRef.current = null;
    });
    inferenceInitPromiseRef.current = promise;
    return promise;
  }, [addDiagnostic, patchSnapshot]);

  const appendOutput = useCallback((output: { frame: number; time: number; timestamp_us: number; width: number; height: number; candidates: RawFrame['hands']; inferenceMs: number; delegate: 'GPU' | 'CPU' | 'unknown' }, dropped = false, errors?: string[]) => {
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
      raw.flags = { ...raw.flags, needsReview: true, errors: [...(raw.flags?.errors ?? []), message] };
      addDiagnostic({ code: 'trajectory_store', severity: 'error', message, frame: raw.frame, time: raw.time });
    }
    diagnosticsRef.current.recordInference(output.inferenceMs, dropped);
    diagnosticsRef.current.ingestRaw(raw);
    if (semantic) diagnosticsRef.current.ingestSemantic(semantic);
    patchSnapshot((current) => ({
      overlay: semantic ? buildOverlay(trajectoryRef.current.getSemanticFrames(), output.width, output.height, output.frame, output.time) : current.overlay,
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
  }, [addDiagnostic, patchSnapshot, publishDiagnostics]);

  const handleLiveFrame = useCallback(async (frame: { image: HTMLVideoElement; mediaTime: number; presentedFrames?: number; width: number; height: number }) => {
    if (liveBusyRef.current) {
      diagnosticsRef.current.recordInference(0, true);
      patchSnapshot((current) => ({ metrics: { ...current.metrics, droppedFrames: current.metrics.droppedFrames + 1 } }));
      return;
    }
    const client = inferenceRef.current;
    if (!client || !inferenceInitRef.current) return;
    liveBusyRef.current = true;
    const now = performance.now();
    if (!liveWindowRef.current.startedAt) liveWindowRef.current.startedAt = now;
    liveWindowRef.current.frames += 1;
    const frameNumber = typeof frame.presentedFrames === 'number' ? Math.max(0, frame.presentedFrames - 1) : liveFrameRef.current;
    liveFrameRef.current = Math.max(liveFrameRef.current + 1, frameNumber + 1);
    try {
      const output = await client.process({
        frame: frameNumber,
        time: frame.mediaTime,
        timestamp_us: Math.round(frame.mediaTime * 1_000_000),
        width: frame.width || videoRef.current?.videoWidth || DEFAULT_WIDTH,
        height: frame.height || videoRef.current?.videoHeight || DEFAULT_HEIGHT,
        image: frame.image,
      });
      if (!output) {
        appendOutput({ frame: frameNumber, time: frame.mediaTime, timestamp_us: Math.round(frame.mediaTime * 1_000_000), width: frame.width, height: frame.height, candidates: [], inferenceMs: 0, delegate: inferenceInitRef.current.delegate }, true);
      } else {
        appendOutput(output);
      }
      const elapsed = performance.now() - liveWindowRef.current.startedAt;
      if (elapsed >= 1000) {
        const actualFps = liveWindowRef.current.frames * 1000 / elapsed;
        liveWindowRef.current = { startedAt: performance.now(), frames: 0 };
        patchSnapshot((current) => ({ metrics: { ...current.metrics, actualFps } }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Live inference failed.';
      appendOutput({ frame: frameNumber, time: frame.mediaTime, timestamp_us: Math.round(frame.mediaTime * 1_000_000), width: frame.width, height: frame.height, candidates: [], inferenceMs: 0, delegate: inferenceInitRef.current.delegate }, true, [message]);
      addDiagnostic({ code: 'live_inference', severity: 'error', message, frame: frameNumber, time: frame.mediaTime });
    } finally {
      liveBusyRef.current = false;
    }
  }, [addDiagnostic, appendOutput, patchSnapshot]);

  const startLiveFrames = useCallback(() => {
    const session = cameraRef.current;
    if (!session) return;
    session.startFrames((frame) => { void handleLiveFrame(frame); });
    liveFrameRef.current = 0;
    liveWindowRef.current = { startedAt: performance.now(), frames: 0 };
  }, [handleLiveFrame]);

  const requestCamera = useCallback(async (cameraIdOverride?: string) => {
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
    try {
      const source = snapshot.source;
      if (source.kind === 'file' || source.kind === 'recording') revokeVideoUrl();
      const session = cameraRef.current ?? new CameraSession(videoRef.current ?? undefined);
      cameraRef.current = session;
      // StageCanvas owns the visible mirror transform; keep the camera source untransformed
      // so the overlay and video cannot be mirrored twice.
      session.setMirror(false);
      const metadata = await session.request(cameraIdOverride ?? snapshot.selectedCameraId);
      setVideoStream(session.mediaStream ?? null);
      const width = metadata.width || DEFAULT_WIDTH;
      const height = metadata.height || DEFAULT_HEIGHT;
      const init = await ensureInference();
      patchSnapshot((current) => ({
        permission: 'granted',
        phase: 'preview',
        mode: 'live',
        source: { ...current.source, kind: 'camera', width, height, fps: metadata.frameRate ?? DEFAULT_FPS, name: 'camera', duration: undefined },
        overlay: { ...current.overlay, width, height, hands: [], semanticCount: 0 },
        metrics: { ...current.metrics, alignment: 'presentation_time_estimate' },
        diagnostics: current.diagnostics.filter((item) => !['secure-context', 'camera-api', 'permission'].includes(item.id)),
        modelVersion: init.modelVersion,
        delegate: init.delegate,
      }));
      await enumerateCameras();
      startLiveFrames();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : 'UnknownError';
      const detail = cameraErrorMessage(error);
      const permission: PermissionState = name === 'NotAllowedError' ? 'denied' : 'unsupported';
      stopCamera();
      patchSnapshot({ permission, phase: 'error', errorMessage: detail, diagnostics: [diagnostic('permission', name === 'NotAllowedError' ? 'warning' : 'error', 'Camera could not start', detail)] });
    }
  }, [ensureInference, enumerateCameras, patchSnapshot, revokeVideoUrl, snapshot.selectedCameraId, snapshot.source, startLiveFrames, stopCamera]);

  const startPreview = useCallback(async () => {
    if (cameraRef.current?.mediaStream) {
      await ensureInference();
      patchSnapshot({ mode: 'live', phase: 'preview', errorMessage: undefined });
      startLiveFrames();
      return;
    }
    await requestCamera();
  }, [ensureInference, patchSnapshot, requestCamera, startLiveFrames]);

  const startRecording = useCallback(async () => {
    try {
      if (!cameraRef.current?.mediaStream) await requestCamera();
      const stream = cameraRef.current?.mediaStream;
      if (!stream) throw new Error('Camera stream is unavailable.');
      recordingRef.current = startRuntimeRecording(stream);
      patchSnapshot({ mode: 'live', phase: 'recording', errorMessage: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recording failed.';
      addDiagnostic({ code: 'recorder', severity: 'error', message });
      patchSnapshot({ phase: 'error', errorMessage: message });
    }
  }, [addDiagnostic, patchSnapshot, requestCamera]);

  const stopRecording = useCallback(async () => {
    const recorder = recordingRef.current;
    recordingRef.current = null;
    if (!recorder) return;
    try {
      const blob = await recorder.stop();
      const file = new File([blob], 'capture.webm', { type: blob.type || recorder.mimeType || 'video/webm' });
      const metadata = await inspectVideoFile(file);
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
      const message = error instanceof Error ? error.message : 'Recording could not be prepared for precise processing.';
      addDiagnostic({ code: 'recording_prepare', severity: 'error', message });
      patchSnapshot({ phase: 'error', errorMessage: message });
    }
  }, [addDiagnostic, patchSnapshot, revokeVideoUrl, snapshot.source.fps, stopCamera]);

  const importVideo = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/') && !/\.(webm|mp4|m4v|mov|ogv)$/i.test(file.name)) {
      patchSnapshot({ phase: 'error', errorMessage: 'Unsupported video file', diagnostics: [diagnostic('decode', 'error', 'Unsupported video file', 'Choose a browser-decodable WebM or H.264 MP4.')] });
      return;
    }
    try {
      processingAbortRef.current?.abort();
      revokeVideoUrl();
      stopCamera();
      const metadata = await inspectVideoFile(file);
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
      const message = error instanceof Error ? error.message : 'Video could not be decoded.';
      addDiagnostic({ code: 'decode', severity: 'error', message });
      patchSnapshot({ phase: 'error', errorMessage: message });
    }
  }, [addDiagnostic, patchSnapshot, revokeVideoUrl, stopCamera]);

  const processSource = useCallback(async () => {
    const metadata = sourceMetadataRef.current;
    if (!metadata || (snapshot.source.kind !== 'file' && snapshot.source.kind !== 'recording')) return;
    if (processingAbortRef.current) processingAbortRef.current.abort();
    const abort = new AbortController();
    processingAbortRef.current = abort;
    trajectoryRef.current.clear();
    diagnosticsRef.current.clear();
    exportRef.current = null;
    publishDiagnostics();
    patchSnapshot({ phase: 'processing', processProgress: 0, errorMessage: undefined, metrics: { ...snapshot.metrics, processedFrames: 0, totalFrames: undefined, droppedFrames: 0, alignment: 'unknown' }, export: { ...snapshot.export, standardReady: false, diagnosticsReady: false, quality: 'pending' } });
    try {
      const init = await ensureInference();
      let processedFrames = 0;
      let totalFrames: number | undefined;
      const processResult = await processVideoFile(metadata, {
        signal: abort.signal,
        onProgress: ({ frame, processedFrames: reportedProcessed, sourceFrames, estimatedTotalFrames }) => {
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
          appendOutput({
            frame: gap.frame,
            time: gap.mediaTime,
            timestamp_us: gap.timestampUs,
            width: metadata.width,
            height: metadata.height,
            candidates: [],
            inferenceMs: 0,
            delegate: inferenceInitRef.current?.delegate ?? init.delegate,
          }, true, [gap.reason]);
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
          let output;
          try {
            output = await inferenceRef.current?.process({ frame: frame.frame, time: frame.mediaTime, timestamp_us: frame.timestampUs, width: metadata.width, height: metadata.height, image: frame.image });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Precise inference failed.';
            appendOutput({ frame: frame.frame, time: frame.mediaTime, timestamp_us: frame.timestampUs, width: metadata.width, height: metadata.height, candidates: [], inferenceMs: 0, delegate: inferenceInitRef.current?.delegate ?? init.delegate }, true, [message]);
            return;
          }
          if (!output) {
            appendOutput({ frame: frame.frame, time: frame.mediaTime, timestamp_us: frame.timestampUs, width: metadata.width, height: metadata.height, candidates: [], inferenceMs: 0, delegate: init.delegate }, true, ['Inference returned no frame.']);
            return;
          }
          appendOutput(output);
        },
      });
      if (abort.signal.aborted) return;
      const semanticFrames = [...trajectoryRef.current.getSemanticFrames()];
      const rawFrames = [...trajectoryRef.current.getRawFrames()];
      const summary = trajectoryRef.current.summary();
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
        mirror: snapshot.source.mirrored,
        rotationDegrees: snapshot.source.rotation,
        orientationTransform: snapshot.source.orientationLabel ?? 'identity',
        inferenceWidth: metadata.width,
        inferenceHeight: metadata.height,
        delegate: init.delegate,
        diagnostics: { ...diagnostics.quality, summary },
        transitions: { count: summary.transitions.length, events: summary.transitions },
        sourceFrameCount: processResult.sourceFrameCount,
        derivedFps: processResult.derivedFps,
        diagnosticEvents: diagnostics.events,
      }, semanticFrames, rawFrames, buildGeometryHints(semanticFrames), {
        fingertipSeries: trajectoryRef.current.fingertipSeries(),
        palmSeries: trajectoryRef.current.palmSeries(),
      });
      exportRef.current = built;
      const quality = diagnostics.quality.needs_review || summary.needsReviewFrames > 0 || summary.identityAmbiguousFrames > 0 ? 'needs_review' : 'ready';
      patchSnapshot({
        phase: 'complete',
        processProgress: 100,
        metrics: { ...snapshot.metrics, processedFrames, totalFrames: processResult.sourceFrameCount, alignment: processResult.alignment, droppedFrames: summary.droppedFrames },
        export: { standardReady: true, diagnosticsReady: true, quality, fileName: built.standardFileName.replace(/\.zip$/, ''), sizeBytes: built.standardBlob.size, generatedAt: Date.now() },
      });
      publishDiagnostics();
    } catch (error) {
      if (abort.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        patchSnapshot({ phase: 'ready', processProgress: undefined });
        return;
      }
      const message = error instanceof Error ? error.message : 'Precise processing failed.';
      addDiagnostic({ code: 'processing', severity: 'error', message });
      patchSnapshot({ phase: 'error', errorMessage: message, processProgress: undefined, export: { ...snapshot.export, quality: 'error' } });
    } finally {
      if (processingAbortRef.current === abort) processingAbortRef.current = null;
    }
  }, [addDiagnostic, appendOutput, ensureInference, patchSnapshot, processVideoFile, publishDiagnostics, snapshot.export, snapshot.metrics, snapshot.source]);

  const cancelProcessing = useCallback(() => {
    processingAbortRef.current?.abort();
    processingAbortRef.current = null;
    patchSnapshot({ phase: 'ready', processProgress: undefined });
  }, [patchSnapshot]);

  const clearSession = useCallback(() => {
    processingAbortRef.current?.abort();
    processingAbortRef.current = null;
    const recorder = recordingRef.current;
    recordingRef.current = null;
    if (recorder) void recorder.stop();
    stopCamera();
    revokeVideoUrl();
    inferenceRef.current?.dispose();
    inferenceRef.current = null;
    inferenceInitRef.current = null;
    diagnosticsRef.current.clear();
    trajectoryRef.current.clear();
    exportRef.current = null;
    setSnapshot(initialSnapshot(snapshot.language));
  }, [revokeVideoUrl, snapshot.language, stopCamera]);

  const toggleMirror = useCallback(() => {
    patchSnapshot((current) => {
      const mirrored = !current.source.mirrored;
      cameraRef.current?.setMirror(false);
      return { source: { ...current.source, mirrored } };
    });
  }, [patchSnapshot]);

  const selectCamera = useCallback(async (cameraId: string) => {
    patchSnapshot({ selectedCameraId: cameraId });
    if (cameraRef.current?.mediaStream) {
      await requestCamera(cameraId);
    }
  }, [patchSnapshot, requestCamera]);

  const setMode = useCallback((mode: CaptureMode) => {
    patchSnapshot({ mode });
  }, [patchSnapshot]);

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

  useEffect(() => {
    checkCapabilities();
    return () => {
      processingAbortRef.current?.abort();
      const recorder = recordingRef.current;
      recordingRef.current = null;
      if (recorder) void recorder.stop();
      cameraRef.current?.stop();
      cameraRef.current = null;
      inferenceRef.current?.dispose();
      inferenceRef.current = null;
      revokeSourceVideoUrl(sourceMetadataRef.current);
      sourceMetadataRef.current = undefined;
    };
  }, [checkCapabilities]);

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
  }), [cancelProcessing, checkCapabilities, clearSession, downloadDiagnostics, downloadStandard, importVideo, processSource, requestCamera, selectCamera, setLanguage, setMode, setPrivacyOpen, startPreview, startRecording, stopRecording, toggleMirror]);

  return { snapshot, actions, videoStream, videoUrl, videoRef, updateVideoMetadata };
}

export default function App({ controller: externalController, initialLanguage }: AppProps) {
  const localController = useLocalCaptureController(initialLanguage);
  const controller = externalController ?? localController;
  const { snapshot, actions } = controller;
  const videoRef = controller.videoRef ?? localController.videoRef;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(true);
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
            <StageCanvas language={lang} source={snapshot.source} overlay={snapshot.overlay} phase={snapshot.phase} mirror={snapshot.source.mirrored} videoStream={controller.videoStream} videoUrl={controller.videoUrl} videoRef={videoRef} onVideoMetadata={handleVideoMetadata} onVideoError={() => actions.setPrivacyOpen(false)} />
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
            <ExportPanel language={lang} exportState={snapshot.export} onStandard={actions.downloadStandard} onDiagnostics={actions.downloadDiagnostics} />
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
