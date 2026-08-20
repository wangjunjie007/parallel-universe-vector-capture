/**
 * Shared, serialisable contracts for the local hand-capture pipeline.
 *
 * Coordinates in this module are always source-video pixels, with a top-left
 * origin and no preview mirroring applied.  Keeping that rule in one place is
 * important because the preview may be mirrored while exports must not be.
 */

export const HAND_IDS = ['hand_1', 'hand_2'] as const;
export type HandId = (typeof HAND_IDS)[number];

export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'little'] as const;
export type FingerName = (typeof FINGER_NAMES)[number];

export const GESTURE_STATES = ['none', 'pinch', 'partial_open', 'all_open'] as const;
export type GestureState = (typeof GESTURE_STATES)[number];

export type CaptureMode = 'realtime' | 'precise';
export type AlignmentMode = 'exact_source_frames' | 'presentation_time_estimate';
export type CoordinateSpace = 'source_pixels_top_left';

export interface Point2D {
  x: number;
  y: number;
}

export interface NormalizedPoint3D {
  x: number;
  y: number;
  z?: number;
}

/** A detector landmark before any semantic correction or smoothing. */
export interface RawLandmark {
  index: number;
  name: string;
  normalized: NormalizedPoint3D;
  source: Point2D;
}

/** Inputs accepted from MediaPipe adapters and deterministic test fixtures. */
export interface RawHandCandidate {
  /** Detector-local index. It is not a persistent identity. */
  candidateIndex: number;
  landmarks: RawLandmark[];
  handedness?: 'Left' | 'Right' | 'Unknown';
  confidence?: number;
}

export interface RawHandObservation extends RawHandCandidate {
  /** Assigned only after temporal identity matching. */
  side?: HandId;
  palmCenter?: Point2D;
  wrist?: Point2D;
  palmScale?: number;
  palmOrientation?: number;
  identityAmbiguous?: boolean;
}

export interface RawFrameFlags {
  dropped?: boolean;
  duplicate?: boolean;
  decodeGap?: boolean;
  identityAmbiguous?: boolean;
  identityReset?: HandId[];
  backgroundPaused?: boolean;
  needsReview?: boolean;
  errors?: string[];
}

export interface RawFrame {
  frame: number;
  time: number;
  timestamp_us: number;
  width: number;
  height: number;
  hands: RawHandObservation[];
  flags?: RawFrameFlags;
}

export interface TrackedHand extends RawHandObservation {
  side: HandId;
  palmCenter: Point2D;
  wrist: Point2D;
  palmScale: number;
  palmOrientation: number;
  identityAmbiguous: boolean;
}

export interface IdentityFrameInput {
  frame: number;
  time: number;
  timestamp_us?: number;
  width: number;
  height: number;
  candidates: RawHandCandidate[];
}

export interface IdentityFrameResult {
  frame: number;
  time: number;
  timestamp_us: number;
  width: number;
  height: number;
  hands: TrackedHand[];
  identityAmbiguous: boolean;
  identityReset: HandId[];
  unmatchedCandidates: number[];
  diagnostics: string[];
}

export interface SemanticPoint {
  side: HandId;
  finger: FingerName;
  x: number;
  y: number;
}

/**
 * Pinch correction metadata belongs only to the extended trajectory layer.
 * `releaseBlend` is the measured-tip weight: 0 is fully compressed and 1 is
 * the unmodified detector position.
 */
export interface ExtendedSemanticPoint extends SemanticPoint {
  compressed?: boolean;
  releaseBlend?: number;
}

export interface PalmSample {
  side: HandId;
  x: number;
  y: number;
  scale: number;
  orientation: number;
  visible: boolean;
  identityAmbiguous?: boolean;
}

/**
 * A fingertip trajectory sample.  Missing samples are explicit nulls rather
 * than NaN so JSON exports remain standards-compliant and consumers cannot
 * mistake a long decode/visibility gap for a measured coordinate.
 */
export interface FingerSample {
  side: HandId;
  finger: FingerName;
  x: number | null;
  y: number | null;
  frame: number;
  time: number;
  timestamp_us: number;
  interpolated?: boolean;
  compressed?: boolean;
  releaseBlend?: number;
  quality?: number;
  missing?: boolean;
  longGap?: boolean;
}

export interface SemanticTransition {
  type:
    | 'tracking_started'
    | 'pinch_confirmed'
    | 'pinch_released'
    | 'all_open_confirmed'
    | 'identity_reset'
    | 'identity_ambiguous'
    | 'hand_disappeared';
  frame: number;
  time: number;
  side?: HandId;
  count?: number;
}

export interface SemanticFrameFlags {
  identityAmbiguous?: boolean;
  identityReset?: HandId[];
  needsReview?: boolean;
  interpolated?: boolean;
  longGap?: boolean;
  errors?: string[];
}

/**
 * A corrected semantic frame. `points` is the strict 0/4/10 compatibility
 * layer; `extendedPoints` intentionally retains partial-open observations.
 */
export interface SemanticFrame {
  frame: number;
  time: number;
  timestamp_us: number;
  width: number;
  height: number;
  state: GestureState;
  count: 0 | 4 | 10;
  points: SemanticPoint[];
  extendedPoints: ExtendedSemanticPoint[];
  palms: PalmSample[];
  transitions: SemanticTransition[];
  flags: SemanticFrameFlags;
}

export interface GeometryEdge {
  id: string;
  from: string;
  to: string;
  kind: 'perimeter' | 'internal' | 'corresponding' | 'complete';
}

export interface GeometryFace {
  face_id: string;
  point_ids: string[];
  topology: 'quad' | 'partial' | 'complete';
  stable: boolean;
}

export interface GeometryHintFrame {
  frame: number;
  time: number;
  state: GestureState;
  point_ids: string[];
  edges: GeometryEdge[];
  faces: GeometryFace[];
  quality: {
    valid: boolean;
    warnings: string[];
  };
}

export interface TrackingConfig {
  confirmationFrames: number;
  pinchReleaseConfirmationFrames: number;
  pinchGapPxAt1280: number;
  pinchReleaseBlendFrames: number;
  pinchEnterNormalized: number;
  pinchExitNormalized: number;
  shortGapFrames: number;
  maxIdentityGapFrames: number;
}

export const DEFAULT_TRACKING_CONFIG: TrackingConfig = {
  confirmationFrames: 6,
  pinchReleaseConfirmationFrames: 1,
  pinchGapPxAt1280: 1.5,
  pinchReleaseBlendFrames: 3,
  pinchEnterNormalized: 0.38,
  pinchExitNormalized: 0.52,
  shortGapFrames: 3,
  maxIdentityGapFrames: 8,
};

export interface SourceMetadata {
  name?: string;
  width: number;
  height: number;
  fps?: number;
  durationSeconds?: number;
  timebase?: string;
  sha256?: string;
}

export interface ManifestInput {
  appVersion?: string;
  modelName?: string;
  modelVersion?: string;
  modelSha256?: string;
  wasmSha256?: string;
  captureMode: CaptureMode;
  source?: SourceMetadata;
  width: number;
  height: number;
  fps?: number;
  durationSeconds?: number;
  timebase?: string;
  mirror?: boolean;
  rotationDegrees?: number;
  orientationTransform?: string;
  inferenceWidth?: number;
  inferenceHeight?: number;
  delegate?: 'GPU' | 'CPU' | 'unknown';
  browser?: string;
  system?: string;
  alignment?: AlignmentMode;
  tracking?: Partial<TrackingConfig>;
  transitions?: Record<string, unknown>;
  quality?: Record<string, unknown>;
}

export interface CaptureManifest {
  schema: 'parallel-universe-vector-capture/1';
  app: {
    name: 'parallel-universe-vector-capture';
    version: string;
  };
  model: {
    name: string;
    version: string;
    sha256?: string;
    wasm_sha256?: string;
    confidence_granularity: 'hand';
  };
  capture: {
    mode: CaptureMode;
    source_name?: string;
    width: number;
    height: number;
    fps?: number;
    duration_seconds?: number;
    timebase?: string;
    source_sha256?: string;
  };
  coordinate_space: CoordinateSpace;
  mirror: boolean;
  rotation_degrees: number;
  orientation_transform: string;
  inference: {
    width?: number;
    height?: number;
    delegate: 'GPU' | 'CPU' | 'unknown';
    browser?: string;
    system?: string;
  };
  tracking: TrackingConfig & {
    allowed_point_counts: readonly [0, 4, 10];
    full_open_count: 10;
    geometry_ten_point_direct_edges: 45;
  };
  transitions: Record<string, unknown>;
  quality: Record<string, unknown>;
  alignment: AlignmentMode;
  privacy: {
    local_only: true;
    uploads: false;
    analytics: false;
  };
}

export interface SemanticTracksFile {
  frame_count: number;
  width: number;
  height: number;
  transitions: Record<string, unknown>;
  frames: Array<{
    frame: number;
    time: number;
    count: 0 | 4 | 10;
    points: SemanticPoint[];
  }>;
}

export interface FingertipTracksFile {
  frame_count: number;
  width: number;
  height: number;
  coordinate_space: CoordinateSpace;
  tracks: Record<string, FingerSample[]>;
}

export interface PalmTracksFile {
  frame_count: number;
  width: number;
  height: number;
  coordinate_space: CoordinateSpace;
  tracks: Record<HandId, PalmTrackSample[]>;
}

/** Export-only palm sample; absent palms are represented explicitly. */
export interface PalmTrackSample {
  side: HandId;
  x: number | null;
  y: number | null;
  scale: number | null;
  orientation: number | null;
  visible: boolean;
  identityAmbiguous?: boolean;
  frame: number;
  time: number;
  timestamp_us: number;
  missing?: boolean;
}

export interface ExportBundle {
  manifest: CaptureManifest;
  semantic_tracks: SemanticTracksFile;
  fingertip_tracks: FingertipTracksFile;
  palm_tracks: PalmTracksFile;
  tracks_csv: string;
  geometry_hints_ndjson: string;
  readme: string;
  raw_landmarks_ndjson?: string;
  diagnostics_ndjson?: string;
  quality?: Record<string, unknown>;
}

export const LANDMARK_NAMES = [
  'wrist',
  'thumb_cmc',
  'thumb_mcp',
  'thumb_ip',
  'thumb_tip',
  'index_mcp',
  'index_pip',
  'index_dip',
  'index_tip',
  'middle_mcp',
  'middle_pip',
  'middle_dip',
  'middle_tip',
  'ring_mcp',
  'ring_pip',
  'ring_dip',
  'ring_tip',
  'little_mcp',
  'little_pip',
  'little_dip',
  'little_tip',
] as const;

export const LANDMARK_INDEX = {
  wrist: 0,
  thumb_cmc: 1,
  thumb_mcp: 2,
  thumb_ip: 3,
  thumb_tip: 4,
  index_mcp: 5,
  index_pip: 6,
  index_dip: 7,
  index_tip: 8,
  middle_mcp: 9,
  middle_pip: 10,
  middle_dip: 11,
  middle_tip: 12,
  ring_mcp: 13,
  ring_pip: 14,
  ring_dip: 15,
  ring_tip: 16,
  little_mcp: 17,
  little_pip: 18,
  little_dip: 19,
  little_tip: 20,
} as const;

export function pointId(point: Pick<SemanticPoint, 'side' | 'finger'>): string {
  return `${point.side}:${point.finger}`;
}

export function clonePoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y };
}

export function cloneSemanticPoint(point: SemanticPoint): SemanticPoint {
  return { side: point.side, finger: point.finger, x: point.x, y: point.y };
}
