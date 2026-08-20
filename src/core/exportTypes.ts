import {
  DEFAULT_TRACKING_CONFIG,
  FINGER_NAMES,
  HAND_IDS,
  pointId,
  type CaptureManifest,
  type FingertipTracksFile,
  type FingerSample,
  type GeometryHintFrame,
  type ManifestInput,
  type PalmTracksFile,
  type SemanticFrame,
  type SemanticPoint,
  type SemanticTracksFile,
  type TrackingConfig,
  type ExportBundle,
} from './types';
import { buildGeometryHints, geometryHintsToNdjson } from './geometryHintBuilder';

export interface SemanticExportOptions {
  frameCount?: number;
  width?: number;
  height?: number;
  transitions?: Record<string, unknown>;
}

export interface SemanticValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function safeSourceName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const basename = name.replaceAll('\\', '/').split('/').pop() ?? '';
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '');
  return sanitized || undefined;
}

function mergedTrackingConfig(input: ManifestInput): TrackingConfig {
  return {
    ...DEFAULT_TRACKING_CONFIG,
    ...(input.tracking ?? {}),
    confirmationFrames: Math.max(1, Math.round(input.tracking?.confirmationFrames ?? DEFAULT_TRACKING_CONFIG.confirmationFrames)),
    pinchReleaseBlendFrames: Math.max(1, Math.round(input.tracking?.pinchReleaseBlendFrames ?? DEFAULT_TRACKING_CONFIG.pinchReleaseBlendFrames)),
  };
}

export function createManifest(input: ManifestInput): CaptureManifest {
  const tracking = mergedTrackingConfig(input);
  return {
    schema: 'parallel-universe-vector-capture/1',
    app: {
      name: 'parallel-universe-vector-capture',
      version: input.appVersion ?? '0.1.0',
    },
    model: {
      name: input.modelName ?? 'MediaPipe Hand Landmarker',
      // Keep the default aligned with the pinned package in package.json. A
      // runtime adapter may override this when it loads a different model.
      version: input.modelVersion ?? '0.10.35',
      ...(input.modelSha256 ? { sha256: input.modelSha256 } : {}),
      ...(input.wasmSha256 ? { wasm_sha256: input.wasmSha256 } : {}),
      confidence_granularity: 'hand',
    },
    capture: {
      mode: input.captureMode,
      ...(safeSourceName(input.source?.name) ? { source_name: safeSourceName(input.source?.name) } : {}),
      width: input.width,
      height: input.height,
      ...(input.fps ?? input.source?.fps ? { fps: input.fps ?? input.source?.fps } : {}),
      ...(input.durationSeconds ?? input.source?.durationSeconds ? { duration_seconds: input.durationSeconds ?? input.source?.durationSeconds } : {}),
      ...(input.timebase ?? input.source?.timebase ? { timebase: input.timebase ?? input.source?.timebase } : {}),
      ...(input.source?.sha256 ? { source_sha256: input.source.sha256 } : {}),
    },
    coordinate_space: 'source_pixels_top_left',
    mirror: input.mirror ?? false,
    rotation_degrees: input.rotationDegrees ?? 0,
    orientation_transform: input.orientationTransform ?? 'identity',
    inference: {
      ...(input.inferenceWidth ? { width: input.inferenceWidth } : {}),
      ...(input.inferenceHeight ? { height: input.inferenceHeight } : {}),
      delegate: input.delegate ?? 'unknown',
      ...(input.browser ? { browser: input.browser } : {}),
      ...(input.system ? { system: input.system } : {}),
    },
    tracking: {
      ...tracking,
      allowed_point_counts: [0, 4, 10],
      full_open_count: 10,
      geometry_ten_point_direct_edges: 45,
    },
    transitions: input.transitions ?? {},
    quality: input.quality ?? {},
    alignment: input.alignment ?? (input.captureMode === 'precise' ? 'exact_source_frames' : 'presentation_time_estimate'),
    privacy: { local_only: true, uploads: false, analytics: false },
  };
}

function dimensions(frames: SemanticFrame[], options: SemanticExportOptions): { width: number; height: number } {
  return {
    width: options.width ?? frames[0]?.width ?? 0,
    height: options.height ?? frames[0]?.height ?? 0,
  };
}

function sortedFrames(frames: SemanticFrame[]): SemanticFrame[] {
  return [...frames].sort((a, b) => a.frame - b.frame || a.time - b.time);
}

function sortedPoints(points: SemanticPoint[]): SemanticPoint[] {
  const fingerRank = new Map(FINGER_NAMES.map((finger, index) => [finger, index]));
  return [...points].sort((a, b) => a.side.localeCompare(b.side) || (fingerRank.get(a.finger) ?? 99) - (fingerRank.get(b.finger) ?? 99));
}

function transitionRecord(frames: SemanticFrame[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const release: Record<string, { frame: number; time: number }> = {};
  for (const frame of frames) {
    for (const item of frame.transitions) {
      if (item.type === 'pinch_released' && item.side) release[item.side] = { frame: item.frame, time: item.time };
      if (item.type === 'all_open_confirmed') result.both_hands_all_fingers_open = { frame: item.frame, time: item.time, count: 10 };
      if (item.type === 'tracking_started') result.tracking_started = { frame: item.frame, time: item.time, count: item.count ?? 4 };
    }
  }
  if (Object.keys(release).length > 0) result.per_hand_pinch_release = release;
  return result;
}

export function validateSemanticFrames(frames: SemanticFrame[], options: SemanticExportOptions = {}): SemanticValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sorted = sortedFrames(frames);
  let previousFrame = -1;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const frame of sorted) {
    if (frame.frame <= previousFrame) errors.push(`frame_not_strictly_increasing:${frame.frame}`);
    if (frame.time < previousTime) errors.push(`time_not_monotonic:${frame.frame}`);
    previousFrame = frame.frame;
    previousTime = frame.time;
    if (![0, 4, 10].includes(frame.count)) errors.push(`invalid_count:${frame.frame}`);
    if (frame.count !== frame.points.length) errors.push(`count_mismatch:${frame.frame}:${frame.count}:${frame.points.length}`);
    const ids = new Set<string>();
    for (const point of frame.points) {
      const id = pointId(point);
      if (ids.has(id)) errors.push(`duplicate_point:${frame.frame}:${id}`);
      ids.add(id);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) errors.push(`non_finite_point:${frame.frame}:${id}`);
      if (point.x < 0 || point.y < 0 || point.x > frame.width || point.y > frame.height) warnings.push(`point_out_of_bounds:${frame.frame}:${id}`);
    }
    if (frame.state === 'none' && frame.count !== 0) errors.push(`none_state_nonzero:${frame.frame}`);
    if (frame.state === 'all_open' && frame.count !== 10) errors.push(`all_open_not_ten:${frame.frame}`);
  }
  if (options.frameCount !== undefined && options.frameCount < (sorted.at(-1)?.frame ?? -1) + 1) warnings.push('frame_count_less_than_max_frame');
  return { valid: errors.length === 0, errors, warnings };
}

export function buildSemanticTracks(frames: SemanticFrame[], options: SemanticExportOptions = {}): SemanticTracksFile {
  const sorted = sortedFrames(frames);
  const { width, height } = dimensions(sorted, options);
  const frameCount = options.frameCount ?? ((sorted.at(-1)?.frame ?? -1) + 1);
  return {
    frame_count: Math.max(0, frameCount),
    width,
    height,
    transitions: { ...transitionRecord(sorted), ...(options.transitions ?? {}) },
    frames: sorted.map((frame) => ({
      frame: frame.frame,
      time: frame.time,
      count: frame.count,
      points: sortedPoints(frame.points).map((point) => ({ ...point })),
    })),
  };
}

export function buildFingertipTracks(frames: SemanticFrame[], options: SemanticExportOptions = {}): FingertipTracksFile {
  const sorted = sortedFrames(frames);
  const { width, height } = dimensions(sorted, options);
  const tracks: Record<string, FingerSample[]> = {};
  for (const frame of sorted) {
    for (const point of sortedPoints(frame.extendedPoints)) {
      const id = pointId(point);
      (tracks[id] ??= []).push({
        ...point,
        frame: frame.frame,
        time: frame.time,
        timestamp_us: frame.timestamp_us,
        interpolated: frame.flags.interpolated,
        quality: frame.flags.needsReview ? 0 : 1,
      });
    }
  }
  return { frame_count: options.frameCount ?? ((sorted.at(-1)?.frame ?? -1) + 1), width, height, coordinate_space: 'source_pixels_top_left', tracks };
}

export function buildPalmTracks(frames: SemanticFrame[], options: SemanticExportOptions = {}): PalmTracksFile {
  const sorted = sortedFrames(frames);
  const { width, height } = dimensions(sorted, options);
  const tracks: PalmTracksFile['tracks'] = { hand_1: [], hand_2: [] };
  for (const frame of sorted) {
    const bySide = new Map(frame.palms.map((palm) => [palm.side, palm]));
    for (const side of HAND_IDS) {
      const palm = bySide.get(side);
      tracks[side].push({
        frame: frame.frame,
        time: frame.time,
        timestamp_us: frame.timestamp_us,
        side,
        x: palm?.x ?? Number.NaN,
        y: palm?.y ?? Number.NaN,
        scale: palm?.scale ?? Number.NaN,
        orientation: palm?.orientation ?? Number.NaN,
        visible: Boolean(palm?.visible),
        ...(palm?.identityAmbiguous ? { identityAmbiguous: true } : {}),
      });
    }
  }
  return { frame_count: options.frameCount ?? ((sorted.at(-1)?.frame ?? -1) + 1), width, height, coordinate_space: 'source_pixels_top_left', tracks };
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildTracksCsv(frames: SemanticFrame[]): string {
  const rows = ['frame,time,state,point_index,side,finger,x,y,timestamp_us,interpolated'];
  for (const frame of sortedFrames(frames)) {
    for (const [pointIndex, point] of sortedPoints(frame.points).entries()) {
      rows.push([
        frame.frame,
        frame.time,
        frame.state,
        pointIndex,
        point.side,
        point.finger,
        point.x,
        point.y,
        frame.timestamp_us,
        Boolean(frame.flags.interpolated),
      ].map(csvCell).join(','));
    }
  }
  return `${rows.join('\n')}\n`;
}

export function buildReadme(manifest: CaptureManifest): string {
  return [
    'Parallel Universe Vector Capture export',
    '',
    `Schema: ${manifest.schema}`,
    `Coordinate space: ${manifest.coordinate_space}`,
    `Alignment: ${manifest.alignment}`,
    'Processing is local to the browser. No video, landmarks, or trajectories are uploaded.',
    '',
    'semantic_tracks.json is the strict 0/4/10 compatibility layer.',
    'fingertip_tracks.json and palm_tracks.json retain extended trajectories for diagnostics.',
    'geometry-hints.ndjson contains preview/export hints; final portal face acceptance remains offline.',
    '',
  ].join('\n');
}

export function buildExportBundle(frames: SemanticFrame[], manifestInput: ManifestInput, rawLandmarksNdjson?: string, diagnosticsNdjson?: string): ExportBundle {
  const manifest = createManifest(manifestInput);
  const options = { width: manifest.capture.width, height: manifest.capture.height };
  const semantic_tracks = buildSemanticTracks(frames, options);
  const fingertip_tracks = buildFingertipTracks(frames, options);
  const palm_tracks = buildPalmTracks(frames, options);
  const hints: GeometryHintFrame[] = buildGeometryHints(frames);
  const validation = validateSemanticFrames(frames, options);
  const quality = { valid: validation.valid, errors: validation.errors, warnings: validation.warnings, frame_count: semantic_tracks.frame_count };
  return {
    manifest: { ...manifest, quality: { ...manifest.quality, ...quality } },
    semantic_tracks,
    fingertip_tracks,
    palm_tracks,
    tracks_csv: buildTracksCsv(frames),
    geometry_hints_ndjson: geometryHintsToNdjson(hints),
    readme: buildReadme(manifest),
    ...(rawLandmarksNdjson ? { raw_landmarks_ndjson: rawLandmarksNdjson } : {}),
    ...(diagnosticsNdjson ? { diagnostics_ndjson: diagnosticsNdjson } : {}),
    quality,
  };
}
