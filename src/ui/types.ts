export type Language = 'zh' | 'en';

export type CaptureMode = 'live' | 'precise';

export type CapturePhase =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'loading-model'
  | 'preview'
  | 'recording'
  | 'processing'
  | 'complete'
  | 'error';

export type PermissionState = 'idle' | 'checking' | 'granted' | 'denied' | 'unsupported';

export type CapabilityState = 'available' | 'unavailable' | 'unknown';

export type HandSide = 'hand_1' | 'hand_2';

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'little';

export type GestureState = 'none' | 'pinch' | 'partial_open' | 'all_open';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface CapabilityCheck {
  state: CapabilityState;
  detail?: string;
}

export interface CapabilitySnapshot {
  secureContext: CapabilityCheck;
  camera: CapabilityCheck;
  workers: CapabilityCheck;
  wasm: CapabilityCheck;
  videoFrameCallback: CapabilityCheck;
  checkedAt?: number;
}

export interface UiVector {
  x: number;
  y: number;
  /** Optional normalized source coordinates for drawing before dimensions are known. */
  nx?: number;
  ny?: number;
}

export interface UiPoint extends UiVector {
  side: HandSide;
  finger: FingerName;
  visible?: boolean;
  interpolated?: boolean;
  confidence?: number;
  trail?: UiVector[];
}

export interface UiHand {
  side: HandSide;
  state: GestureState;
  palm?: UiVector;
  scale?: number;
  orientation?: number;
  points: UiPoint[];
  trail?: UiVector[];
  confidence?: number;
}

export interface OverlaySnapshot {
  width: number;
  height: number;
  hands: UiHand[];
  semanticCount: 0 | 4 | 10;
  /** True when the overlay is explanatory placeholder data, never production output. */
  isSample?: boolean;
  sourceFrame?: number;
  sourceTime?: number;
}

export interface ReplaySnapshot {
  ready: boolean;
  currentTime: number;
  duration: number;
  currentFrame?: number;
  totalFrames?: number;
  playing: boolean;
  /** Quality flags for the currently displayed source frame. */
  flags?: string[];
}

export interface ReplayActions {
  playReplay: () => void | Promise<void>;
  pauseReplay: () => void;
  restartReplay: () => void | Promise<void>;
  seekReplay: (time: number) => void | Promise<void>;
  stepReplay: (direction: -1 | 1) => void | Promise<void>;
}

export interface SourceSnapshot {
  kind: 'none' | 'camera' | 'recording' | 'file';
  name?: string;
  width: number;
  height: number;
  fps?: number;
  duration?: number;
  mirrored: boolean;
  rotation: 0 | 90 | 180 | 270;
  orientationLabel?: string;
}

export interface MetricsSnapshot {
  actualFps?: number;
  inferenceMs?: number;
  droppedFrames: number;
  processedFrames: number;
  totalFrames?: number;
  memoryMb?: number;
  alignment: 'presentation_time_estimate' | 'exact_source_frames' | 'unknown';
}

export interface DiagnosticItem {
  id: string;
  severity: DiagnosticSeverity;
  title: string;
  detail?: string;
  timestamp?: number;
  acknowledged?: boolean;
}

export interface ExportSnapshot {
  standardReady: boolean;
  diagnosticsReady: boolean;
  fileName?: string;
  sizeBytes?: number;
  generatedAt?: number;
  quality: 'pending' | 'ready' | 'needs_review' | 'error';
}

export interface CaptureUiSnapshot {
  language: Language;
  mode: CaptureMode;
  phase: CapturePhase;
  permission: PermissionState;
  capabilities: CapabilitySnapshot;
  source: SourceSnapshot;
  overlay: OverlaySnapshot;
  metrics: MetricsSnapshot;
  diagnostics: DiagnosticItem[];
  export: ExportSnapshot;
  selectedCameraId?: string;
  availableCameras: Array<{ id: string; label: string }>;
  privacyOpen: boolean;
  modelVersion?: string;
  delegate?: 'GPU' | 'CPU' | 'unknown';
  errorMessage?: string;
  processProgress?: number;
  replay?: ReplaySnapshot;
}

export interface CaptureUiActions {
  checkCapabilities: () => void | Promise<void>;
  requestCamera: () => void | Promise<void>;
  startPreview: () => void | Promise<void>;
  startRecording: () => void | Promise<void>;
  stopRecording: () => void | Promise<void>;
  processSource: () => void | Promise<void>;
  cancelProcessing: () => void;
  importVideo: (file: File) => void | Promise<void>;
  clearSession: () => void | Promise<void>;
  toggleMirror: () => void;
  selectCamera: (cameraId: string) => void | Promise<void>;
  setMode: (mode: CaptureMode) => void;
  setLanguage: (language: Language) => void;
  setPrivacyOpen: (open: boolean) => void;
  downloadStandard: () => void | Promise<void>;
  downloadDiagnostics: () => void | Promise<void>;
  playReplay?: () => void | Promise<void>;
  pauseReplay?: () => void;
  restartReplay?: () => void | Promise<void>;
  seekReplay?: (time: number) => void | Promise<void>;
  stepReplay?: (direction: -1 | 1) => void | Promise<void>;
}

export interface CaptureUiController {
  snapshot: CaptureUiSnapshot;
  actions: CaptureUiActions;
  videoStream?: MediaStream | null;
  videoUrl?: string;
  videoRef?: import('react').RefObject<HTMLVideoElement>;
  replay?: ReplaySnapshot;
  replayActions?: Partial<ReplayActions>;
  onReplayTime?: (time: number) => void;
}

export interface AppProps {
  /** A core adapter can replace the local demo controller without changing the UI. */
  controller?: CaptureUiController;
  initialLanguage?: Language;
}
