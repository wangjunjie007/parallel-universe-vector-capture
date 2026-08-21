import { strToU8, zipSync } from 'fflate';
import type { FingerSample, SemanticFrame, SourceMetadata } from '../core/types';

export interface JianyingExportOptions {
  appVersion: string;
  source?: SourceMetadata;
  alignment: 'exact_source_frames' | 'presentation_time_estimate';
  frameCount?: number;
  frames: readonly SemanticFrame[];
  fingertipTracks?: Record<string, readonly FingerSample[]>;
}

export interface JianyingExportResult {
  blob: Blob;
  fileName: string;
  /** Raw ZIP bytes retained for deterministic non-browser validation. */
  bytes: Uint8Array;
}

interface JianyingKeyframe {
  track_id: string;
  side: FingerSample['side'];
  finger: FingerSample['finger'];
  frame: number;
  time: number;
  x: number | null;
  y: number | null;
  x_normalized: number | null;
  y_normalized: number | null;
  visible: boolean;
  interpolated: boolean;
  quality: number | null;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const csvCell = (value: string | number | boolean | null): string => {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function collectTracks(options: JianyingExportOptions): Record<string, FingerSample[]> {
  if (options.fingertipTracks) {
    return Object.fromEntries(Object.entries(options.fingertipTracks).map(([id, samples]) => [id, samples.map((sample) => ({ ...sample }))]));
  }
  const tracks: Record<string, FingerSample[]> = {};
  for (const frame of options.frames) {
    for (const point of frame.extendedPoints) {
      const id = `${point.side}:${point.finger}`;
      (tracks[id] ??= []).push({
        side: point.side,
        finger: point.finger,
        frame: frame.frame,
        time: frame.time,
        timestamp_us: frame.timestamp_us,
        x: point.x,
        y: point.y,
        interpolated: frame.flags.interpolated,
        quality: frame.flags.needsReview ? 0 : 1,
        ...(point.compressed === undefined ? {} : { compressed: point.compressed }),
        ...(point.releaseBlend === undefined ? {} : { releaseBlend: point.releaseBlend }),
      });
    }
  }
  return tracks;
}

export function buildJianyingExport(options: JianyingExportOptions): JianyingExportResult {
  const width = options.frames[0]?.width ?? options.source?.width ?? 0;
  const height = options.frames[0]?.height ?? options.source?.height ?? 0;
  const tracks = collectTracks(options);
  const keyframes: JianyingKeyframe[] = [];
  for (const [trackId, samples] of Object.entries(tracks).sort(([a], [b]) => a.localeCompare(b))) {
    for (const sample of [...samples].sort((a, b) => a.frame - b.frame)) {
      const visible = sample.x !== null && sample.y !== null && !sample.missing;
      keyframes.push({
        track_id: trackId,
        side: sample.side,
        finger: sample.finger,
        frame: sample.frame,
        time: sample.time,
        x: sample.x,
        y: sample.y,
        x_normalized: visible && width > 0 ? sample.x! / width : null,
        y_normalized: visible && height > 0 ? sample.y! / height : null,
        visible,
        interpolated: sample.interpolated === true,
        quality: sample.quality ?? null,
      });
    }
  }
  const manifest = {
    schema: 'parallel-universe-vector-capture/jianying-keyframes/1',
    app: { name: 'parallel-universe-vector-capture', version: options.appVersion },
    format: 'jianying-keyframe-package',
    alignment: options.alignment,
    coordinate_space: 'source_pixels_top_left',
    mirror: false,
    source: {
      name: options.source?.name,
      width,
      height,
      fps: options.source?.fps,
      duration_seconds: options.source?.durationSeconds,
      frame_count: options.frameCount ?? Math.max(0, ...options.frames.map((frame) => frame.frame + 1)),
    },
    tracks: Object.keys(tracks).sort().map((trackId) => {
      const [side, finger] = trackId.split(':');
      return { track_id: trackId, side, finger, keyframe_count: tracks[trackId].length };
    }),
    notes: [
      'This is a conversion-oriented keyframe package for CapCut/Jianying workflows.',
      'It is not an unverified native Jianying draft/project file.',
      'Native project JSON is version-specific and not a public stable interchange format.',
    ],
  };
  const csvRows = ['track_id,side,finger,frame,time,x,y,x_normalized,y_normalized,visible,interpolated,quality'];
  for (const point of keyframes) {
    csvRows.push([
      point.track_id, point.side, point.finger, point.frame, point.time, point.x, point.y,
      point.x_normalized, point.y_normalized, point.visible, point.interpolated, point.quality,
    ].map(csvCell).join(','));
  }
  const alignmentNote = options.alignment === 'exact_source_frames'
    ? '本包来自精确源帧处理。'
    : '注意：本包来自演示时间估计结果，时间轴可能需要在剪映中校准；它没有被标记为精确源帧。';
  const readme = [
    '平行宇宙矢量帧捕捉 / 剪映关键帧包',
    '',
    '用途：将每根手指作为独立轨道，供剪映/CapCut 转换脚本或人工关键帧制作使用。',
    '坐标：source_pixels_top_left，另提供 x_normalized / y_normalized（0-1）。',
    alignmentNote,
    '',
    '重要：这不是未经验证的剪映原生草稿文件。剪映工程 JSON 随版本变化且没有公开稳定的通用导入契约。',
    '请使用 jianying-keyframes.json 或 jianying-keyframes.csv 进行转换或按帧建立动画。',
    '',
  ].join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files = {
    'jianying-keyframes.json': strToU8(json({ ...manifest, keyframes })),
    'jianying-keyframes.csv': strToU8(`${csvRows.join('\n')}\n`),
    'jianying-manifest.json': strToU8(json(manifest)),
    'README.txt': strToU8(readme),
  };
  const bytes = zipSync(files);
  return {
    blob: new Blob([bytes], { type: 'application/zip' }),
    fileName: `parallel-universe-jianying-keyframes-${stamp}.zip`,
    bytes,
  };
}
