import { gzipSync, strToU8, zipSync } from 'fflate';
import type {
  CaptureManifest,
  ExportBundle,
  FingerSample,
  FingertipTracksFile,
  GeometryHintFrame,
  PalmTracksFile,
  PalmTrackSample,
  RawFrame,
  SemanticFrame,
  SemanticTracksFile,
  SourceMetadata,
  TrackingConfig,
} from '../core/types';
import { DEFAULT_TRACKING_CONFIG, pointId } from '../core/types';
import { summarizeGeometryHints } from '../core/exportTypes';
import { buildJianyingExport, type JianyingExportResult } from './jianyingExporter';

export interface ExportBuildOptions {
  appVersion: string;
  modelName: string;
  modelVersion: string;
  modelSha256?: string;
  wasmSha256?: string;
  captureMode: 'realtime' | 'precise';
  alignment: 'exact_source_frames' | 'presentation_time_estimate';
  source?: SourceMetadata;
  mirror: boolean;
  rotationDegrees?: number;
  orientationTransform?: string;
  inferenceWidth?: number;
  inferenceHeight?: number;
  delegate?: 'GPU' | 'CPU' | 'unknown';
  tracking?: Partial<TrackingConfig>;
  diagnostics?: Record<string, unknown>;
  transitions?: Record<string, unknown>;
  /** Number of source frames represented, including explicit gap frames. */
  sourceFrameCount?: number;
  /** Measured source rate (when available) rather than a nominal default. */
  derivedFps?: number;
  /** Runtime diagnostics to include in the full diagnostics package. */
  diagnosticEvents?: readonly unknown[];
}

export interface ExportTrajectoryData {
  fingertipSeries?: Record<string, FingerSample[]>;
  palmSeries?: Record<'hand_1' | 'hand_2', PalmTrackSample[]>;
}

export interface BuiltExport {
  bundle: ExportBundle;
  standardBlob: Blob;
  diagnosticsBlob: Blob;
  standardFileName: string;
  diagnosticsFileName: string;
  jianying?: JianyingExportResult;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const ndjson = (values: readonly unknown[]): string => values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');

function mergeConfig(partial?: Partial<TrackingConfig>): TrackingConfig {
  return { ...DEFAULT_TRACKING_CONFIG, ...partial };
}

function strictSemanticFrames(frames: SemanticFrame[]): SemanticTracksFile['frames'] {
  return [...frames].sort((a, b) => a.frame - b.frame).map((frame) => ({
    frame: frame.frame,
    time: frame.time,
    count: frame.count,
    points: frame.points.map(({ side, finger, x, y }) => ({ side, finger, x, y })),
  }));
}

function sourceFrameCount(frames: SemanticFrame[], rawFrames: RawFrame[], requested?: number): number {
  let highestObserved = -1;
  for (const frame of frames) {
    if (frame.frame > highestObserved) highestObserved = frame.frame;
  }
  for (const frame of rawFrames) {
    if (frame.frame > highestObserved) highestObserved = frame.frame;
  }
  const maxObserved = highestObserved + 1;
  return Math.max(0, requested ?? 0, maxObserved);
}

function buildFingertips(frames: SemanticFrame[], trajectory: ExportTrajectoryData | undefined, frameCount: number): FingertipTracksFile {
  const tracks: FingertipTracksFile['tracks'] = {};
  if (trajectory?.fingertipSeries) {
    for (const [key, samples] of Object.entries(trajectory.fingertipSeries)) tracks[key] = samples.map((sample) => ({ ...sample }));
  }
  for (const frame of frames) {
    if (trajectory?.fingertipSeries) break;
    for (const point of frame.extendedPoints) {
      const key = pointId(point);
      (tracks[key] ??= []).push({
        side: point.side,
        finger: point.finger,
        x: point.x,
        y: point.y,
        frame: frame.frame,
        time: frame.time,
        timestamp_us: frame.timestamp_us,
        interpolated: frame.flags.interpolated,
        ...(point.compressed === undefined ? {} : { compressed: point.compressed }),
        ...(point.releaseBlend === undefined ? {} : { releaseBlend: point.releaseBlend }),
        quality: frame.flags.needsReview ? 0 : 1,
      });
    }
  }
  return {
    frame_count: frameCount,
    width: frames[0]?.width ?? 0,
    height: frames[0]?.height ?? 0,
    coordinate_space: 'source_pixels_top_left',
    tracks,
  };
}

function buildPalms(frames: SemanticFrame[], trajectory: ExportTrajectoryData | undefined, frameCount: number): PalmTracksFile {
  const tracks: PalmTracksFile['tracks'] = { hand_1: [], hand_2: [] };
  if (trajectory?.palmSeries) {
    tracks.hand_1 = trajectory.palmSeries.hand_1.map((sample) => ({ ...sample }));
    tracks.hand_2 = trajectory.palmSeries.hand_2.map((sample) => ({ ...sample }));
  }
  for (const frame of frames) {
    if (trajectory?.palmSeries) break;
    for (const palm of frame.palms) {
      tracks[palm.side].push({ ...palm, frame: frame.frame, time: frame.time, timestamp_us: frame.timestamp_us });
    }
  }
  return {
    frame_count: frameCount,
    width: frames[0]?.width ?? 0,
    height: frames[0]?.height ?? 0,
    coordinate_space: 'source_pixels_top_left',
    tracks,
  };
}

function buildCsv(frames: SemanticFrame[]): string {
  const rows = ['frame,time,state,point_index,side,finger,x,y,timestamp_us,interpolated'];
  for (const frame of frames) {
    frame.points.forEach((point, pointIndex) => {
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
        frame.flags.interpolated ? 'true' : 'false',
      ].join(','));
    });
  }
  return `${rows.join('\n')}\n`;
}

function buildManifest(options: ExportBuildOptions, frames: SemanticFrame[], rawFrames: RawFrame[]): CaptureManifest {
  const tracking = mergeConfig(options.tracking);
  const width = frames[0]?.width ?? rawFrames[0]?.width ?? options.source?.width ?? 0;
  const height = frames[0]?.height ?? rawFrames[0]?.height ?? options.source?.height ?? 0;
  const quality = options.diagnostics ?? {};
  const safeSourceName = options.source?.name
    ?.replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]/g, '_');
  return {
    schema: 'parallel-universe-vector-capture/1',
    app: { name: 'parallel-universe-vector-capture', version: options.appVersion },
    model: {
      name: options.modelName,
      version: options.modelVersion,
      sha256: options.modelSha256,
      wasm_sha256: options.wasmSha256,
      confidence_granularity: 'hand',
    },
    capture: {
      mode: options.captureMode,
      ...(safeSourceName ? { source_name: safeSourceName } : {}),
      width,
      height,
      fps: options.derivedFps ?? options.source?.fps,
      duration_seconds: options.source?.durationSeconds,
      timebase: options.source?.timebase ?? '1/1000000',
      source_sha256: options.source?.sha256,
    },
    coordinate_space: 'source_pixels_top_left',
    mirror: options.mirror,
    rotation_degrees: options.rotationDegrees ?? 0,
    orientation_transform: options.orientationTransform ?? 'identity',
    inference: {
      width: options.inferenceWidth,
      height: options.inferenceHeight,
      delegate: options.delegate ?? 'unknown',
      browser: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      system: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    },
    tracking: {
      ...tracking,
      allowed_point_counts: [0, 4, 10],
      full_open_count: 10,
      geometry_ten_point_direct_edges: 45,
    },
    transitions: options.transitions ?? {},
    quality: {
      ...quality,
      raw_frame_count: rawFrames.length,
      semantic_frame_count: frames.length,
      source_frame_count: sourceFrameCount(frames, rawFrames, options.sourceFrameCount),
    },
    alignment: options.alignment,
    privacy: { local_only: true, uploads: false, analytics: false },
  };
}

const readme = (manifest: CaptureManifest): string => `Parallel Universe Vector Capture export\n\nSchema: ${manifest.schema}\nAlignment: ${manifest.alignment}\nCoordinate space: ${manifest.coordinate_space}\nPrivacy: local_only=true; no uploads\n\nThe strict semantic track intentionally emits only 0, 4, or 10 portal points. Extended fingertip and palm tracks retain partial observations and diagnostics. Real-time captures are presentation-time estimates and should be reprocessed from the recording before final compositing.\n`;

export function buildExport(
  options: ExportBuildOptions,
  semanticFrames: SemanticFrame[],
  rawFrames: RawFrame[],
  geometryFrames: GeometryHintFrame[] = [],
  trajectory?: ExportTrajectoryData,
): BuiltExport {
  const manifest = buildManifest(options, semanticFrames, rawFrames);
  const frameCount = sourceFrameCount(semanticFrames, rawFrames, options.sourceFrameCount);
  const semantic_tracks = {
    frame_count: frameCount,
    width: manifest.capture.width,
    height: manifest.capture.height,
    transitions: manifest.transitions,
    frames: strictSemanticFrames(semanticFrames),
  } satisfies SemanticTracksFile;
  const fingertip_tracks = buildFingertips(semanticFrames, trajectory, frameCount);
  const palm_tracks = buildPalms(semanticFrames, trajectory, frameCount);
  const geometry_hints_ndjson = ndjson(geometryFrames);
  const raw_landmarks_ndjson = ndjson(rawFrames);
  const diagnostics_ndjson = ndjson([
    ...(options.diagnosticEvents ?? []),
    ...rawFrames.flatMap((frame) => frame.flags ? [{ frame: frame.frame, time: frame.time, type: 'raw_flags', flags: frame.flags }] : []),
    ...geometryFrames.flatMap((hint) => (!hint.quality.valid || hint.quality.warnings.length > 0)
      ? [{ frame: hint.frame, time: hint.time, type: 'geometry_flags', flags: hint.quality }]
      : []),
    ...semanticFrames.flatMap((frame) => [
      ...frame.transitions.map((transition) => ({ ...transition, frame: frame.frame })),
      ...(frame.flags.needsReview || frame.flags.longGap || frame.flags.errors?.length
        ? [{ frame: frame.frame, time: frame.time, type: 'semantic_flags', flags: frame.flags }]
        : []),
    ]),
  ]);
  const ambiguousFrames = new Set<number>([
    ...rawFrames.filter((frame) => frame.flags?.identityAmbiguous).map((frame) => frame.frame),
    ...semanticFrames.filter((frame) => frame.flags.identityAmbiguous).map((frame) => frame.frame),
  ]);
  const allFingertips = Object.values(fingertip_tracks.tracks).flat();
  const missingSamples = allFingertips.filter((sample) => sample.missing || sample.x === null || sample.y === null).length;
  const geometryQuality = summarizeGeometryHints(geometryFrames);
  const quality = {
    // A seek-based or gap-containing replay has a useful presentation timeline,
    // but it is not proof of exact source-frame alignment for compositing.
    needs_review: options.alignment !== 'exact_source_frames'
      || rawFrames.some((frame) => frame.flags?.needsReview || frame.flags?.identityAmbiguous || frame.flags?.decodeGap)
      || semanticFrames.some((frame) => frame.flags.needsReview || frame.flags.longGap)
      || missingSamples > 0
      || !geometryQuality.geometry_valid,
    dropped_frames: rawFrames.filter((frame) => frame.flags?.dropped).length,
    decode_gap_frames: rawFrames.filter((frame) => frame.flags?.decodeGap).length,
    identity_ambiguous_frames: ambiguousFrames.size,
    long_gap_frames: semanticFrames.filter((frame) => frame.flags.longGap).length + allFingertips.filter((sample) => sample.longGap).length,
    missing_samples: missingSamples,
    source_frame_count: frameCount,
    ...geometryQuality,
  };
  manifest.quality = { ...manifest.quality, ...quality };
  const bundle: ExportBundle = {
    manifest,
    semantic_tracks,
    fingertip_tracks,
    palm_tracks,
    tracks_csv: buildCsv(semanticFrames),
    geometry_hints_ndjson,
    readme: readme(manifest),
    raw_landmarks_ndjson,
    diagnostics_ndjson,
    quality,
  };
  const standardEntries = {
    'manifest.json': strToU8(json(manifest)),
    'semantic_tracks.json': strToU8(json(semantic_tracks)),
    'fingertip_tracks.json': strToU8(json(fingertip_tracks)),
    'palm_tracks.json': strToU8(json(palm_tracks)),
    'tracks.csv': strToU8(bundle.tracks_csv),
    'geometry-hints.ndjson': strToU8(geometry_hints_ndjson),
    'README.txt': strToU8(bundle.readme),
  };
  const diagnosticEntries = {
    ...standardEntries,
    'raw-landmarks.ndjson.gz': gzipSync(strToU8(raw_landmarks_ndjson)),
    'diagnostics.ndjson': strToU8(diagnostics_ndjson),
    'quality.json': strToU8(json(quality)),
  };
  const standardBlob = new Blob([zipSync(standardEntries)], { type: 'application/zip' });
  const diagnosticsBlob = new Blob([zipSync(diagnosticEntries)], { type: 'application/zip' });
  const jianying = options.alignment === 'exact_source_frames'
    ? buildJianyingExport({
      appVersion: options.appVersion,
      source: options.source,
      alignment: options.alignment,
      frameCount,
      frames: semanticFrames,
      fingertipTracks: fingertip_tracks.tracks,
    })
    : undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    bundle,
    standardBlob,
    diagnosticsBlob,
    standardFileName: `parallel-universe-vector-capture-${stamp}.zip`,
    diagnosticsFileName: `parallel-universe-vector-capture-${stamp}-diagnostics.zip`,
    jianying,
  };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
