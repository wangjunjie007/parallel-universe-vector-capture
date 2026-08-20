import {
  DEFAULT_TRACKING_CONFIG,
  FINGER_NAMES,
  HAND_IDS,
  type ExtendedSemanticPoint,
  type FingerName,
  type FingerSample,
  type IdentityFrameResult,
  type PalmTrackSample,
  type Point2D,
  type RawFrame,
  type SemanticFrame,
  type SemanticPoint,
} from './types';
import { createIdentityTracker, type IdentityTracker, type IdentityTrackerOptions } from './identityTracker';
import { createSemanticProcessor, type SemanticProcessor, type SemanticProcessorOptions } from './gestureSemanticizer';

export interface TrajectoryStoreOptions extends IdentityTrackerOptions, SemanticProcessorOptions {
  maxFrames?: number;
  shortGapFrames?: number;
}

export interface InterpolatedPoint extends Omit<ExtendedSemanticPoint, 'x' | 'y'> {
  frame: number;
  time: number;
  timestamp_us: number;
  x: number | null;
  y: number | null;
  interpolated: boolean;
  longGap?: boolean;
  missing?: boolean;
}

export interface TrajectorySummary {
  frameCount: number;
  width: number;
  height: number;
  droppedFrames: number;
  duplicateFrames: number;
  decodeGaps: number;
  identityAmbiguousFrames: number;
  needsReviewFrames: number;
  longGapFrames: number;
  missingSamples: number;
  transitions: SemanticFrame['transitions'];
}

function cloneRawFrame(frame: RawFrame): RawFrame {
  return JSON.parse(JSON.stringify(frame)) as RawFrame;
}

function pointKey(point: Pick<SemanticPoint, 'side' | 'finger'>): string {
  return `${point.side}:${point.finger}`;
}

function highestFrameIndex(frames: readonly { frame: number }[]): number {
  let highest = -1;
  for (const frame of frames) {
    if (frame.frame > highest) highest = frame.frame;
  }
  return highest;
}

function interpolate(a: Point2D, b: Point2D, factor: number): Point2D {
  return { x: a.x + (b.x - a.x) * factor, y: a.y + (b.y - a.y) * factor };
}

/**
 * Bounded trajectory store. Raw frames and corrected semantic frames remain
 * separate arrays; interpolation only fills short gaps in a derived view.
 */
export class TrajectoryStore {
  public readonly maxFrames: number;
  public readonly shortGapFrames: number;
  public readonly identityTracker: IdentityTracker;
  public readonly semanticProcessor: SemanticProcessor;
  private readonly rawFrames: RawFrame[] = [];
  private readonly semanticFrames: SemanticFrame[] = [];
  private readonly identityFrames: IdentityFrameResult[] = [];
  private readonly frameIndex = new Set<number>();
  private width = 0;
  private height = 0;

  public constructor(options: TrajectoryStoreOptions = {}) {
    this.maxFrames = Math.max(1, Math.floor(options.maxFrames ?? 60 * 60 * 60));
    this.shortGapFrames = Math.max(0, Math.floor(options.shortGapFrames ?? DEFAULT_TRACKING_CONFIG.shortGapFrames));
    this.identityTracker = createIdentityTracker(options);
    this.semanticProcessor = createSemanticProcessor(options);
  }

  public clear(): void {
    this.rawFrames.splice(0);
    this.semanticFrames.splice(0);
    this.identityFrames.splice(0);
    this.frameIndex.clear();
    this.width = 0;
    this.height = 0;
    this.identityTracker.reset();
    this.semanticProcessor.reset();
  }

  public getRawFrames(): readonly RawFrame[] {
    return this.rawFrames;
  }

  public getIdentityFrames(): readonly IdentityFrameResult[] {
    return this.identityFrames;
  }

  public getSemanticFrames(): readonly SemanticFrame[] {
    return this.semanticFrames;
  }

  public appendRawFrame(frame: RawFrame): SemanticFrame | undefined {
    if (this.rawFrames.length >= this.maxFrames) throw new Error(`trajectory_store_limit:${this.maxFrames}`);
    if (this.frameIndex.has(frame.frame)) {
      const duplicate = cloneRawFrame({ ...frame, flags: { ...frame.flags, duplicate: true, needsReview: true } });
      this.rawFrames.push(duplicate);
      return undefined;
    }
    this.frameIndex.add(frame.frame);
    this.width = frame.width;
    this.height = frame.height;
    const storedRaw = cloneRawFrame(frame);
    this.rawFrames.push(storedRaw);
    const identity = this.identityTracker.update({
      frame: frame.frame,
      time: frame.time,
      timestamp_us: frame.timestamp_us,
      width: frame.width,
      height: frame.height,
      candidates: frame.hands,
    });
    this.identityFrames.push(identity);
    const semantic = this.semanticProcessor.processFrame(identity);
    // Decode gaps and inference failures must remain visible in both layers;
    // the semanticizer cannot infer these flags from an empty candidate list.
    const review = frame.flags?.needsReview || frame.flags?.dropped || frame.flags?.decodeGap;
    if (identity.identityAmbiguous) storedRaw.flags = { ...storedRaw.flags, identityAmbiguous: true, needsReview: true };
    if (identity.identityReset.length > 0) storedRaw.flags = { ...storedRaw.flags, identityReset: [...identity.identityReset], needsReview: true };
    if (review || frame.flags?.errors?.length || identity.diagnostics.length > 0) {
      semantic.flags = {
        ...semantic.flags,
        ...(review ? { needsReview: true } : {}),
        ...(frame.flags?.decodeGap ? { longGap: true } : {}),
        ...(frame.flags?.errors?.length || identity.diagnostics.length > 0
          ? { errors: [...(frame.flags?.errors ?? []), ...identity.diagnostics] }
          : {}),
      };
    }
    // Identity diagnostics are derived from the same raw observation. Keep the
    // raw layer authoritative, but expose the derived flags to exporters.
    this.rawFrames[this.rawFrames.length - 1] = storedRaw;
    this.semanticFrames.push(semantic);
    return semantic;
  }

  public appendIdentityFrame(frame: IdentityFrameResult): SemanticFrame {
    if (this.frameIndex.has(frame.frame)) throw new Error(`duplicate_frame:${frame.frame}`);
    if (this.semanticFrames.length >= this.maxFrames) throw new Error(`trajectory_store_limit:${this.maxFrames}`);
    this.frameIndex.add(frame.frame);
    this.width = frame.width;
    this.height = frame.height;
    this.identityFrames.push(frame);
    const semantic = this.semanticProcessor.processFrame(frame);
    this.semanticFrames.push(semantic);
    return semantic;
  }

  /** Append an already semanticized frame (useful for precise replay workers). */
  public appendSemanticFrame(frame: SemanticFrame): void {
    if (this.frameIndex.has(frame.frame)) throw new Error(`duplicate_semantic_frame:${frame.frame}`);
    if (this.semanticFrames.length >= this.maxFrames) throw new Error(`trajectory_store_limit:${this.maxFrames}`);
    this.frameIndex.add(frame.frame);
    this.width = frame.width;
    this.height = frame.height;
    this.semanticFrames.push(frame);
    this.semanticFrames.sort((a, b) => a.frame - b.frame);
  }

  public interpolateSemanticPoints(): InterpolatedPoint[] {
    const frames = [...this.semanticFrames].sort((a, b) => a.frame - b.frame);
    const byKey = new Map<string, Map<number, { point: ExtendedSemanticPoint; frame: SemanticFrame }>>();
    for (const frame of frames) {
      for (const point of frame.extendedPoints) {
        const key = pointKey(point);
        const series = byKey.get(key) ?? new Map<number, { point: ExtendedSemanticPoint; frame: SemanticFrame }>();
        series.set(frame.frame, { point, frame });
        byKey.set(key, series);
      }
    }
    const output: InterpolatedPoint[] = [];
    for (const [key, series] of byKey) {
      const entries = [...series.values()].sort((a, b) => a.frame.frame - b.frame.frame);
      for (let index = 0; index < entries.length; index += 1) {
        const current = entries[index];
        output.push({ ...current.point, frame: current.frame.frame, time: current.frame.time, timestamp_us: current.frame.timestamp_us, interpolated: false });
        const next = entries[index + 1];
        if (!next) continue;
        const gap = next.frame.frame - current.frame.frame - 1;
        if (gap <= 0) continue;
        if (gap > this.shortGapFrames) {
          for (let skipped = 1; skipped <= gap; skipped += 1) {
            output.push({
              side: current.point.side,
              finger: current.point.finger,
              x: null,
              y: null,
              frame: current.frame.frame + skipped,
              time: current.frame.time + ((next.frame.time - current.frame.time) * skipped) / (gap + 1),
              timestamp_us: Math.round(current.frame.timestamp_us + ((next.frame.timestamp_us - current.frame.timestamp_us) * skipped) / (gap + 1)),
              interpolated: false,
              longGap: true,
              missing: true,
            });
          }
          continue;
        }
        for (let skipped = 1; skipped <= gap; skipped += 1) {
          const factor = skipped / (gap + 1);
          const point = interpolate(current.point, next.point, factor);
          const releaseBlend = current.point.releaseBlend !== undefined && next.point.releaseBlend !== undefined
            ? current.point.releaseBlend + (next.point.releaseBlend - current.point.releaseBlend) * factor
            : undefined;
          const compressed = current.point.compressed !== undefined && next.point.compressed !== undefined
            ? current.point.compressed && next.point.compressed
            : undefined;
          output.push({
            ...point,
            side: current.point.side,
            finger: current.point.finger,
            frame: current.frame.frame + skipped,
            time: current.frame.time + (next.frame.time - current.frame.time) * factor,
            timestamp_us: Math.round(current.frame.timestamp_us + (next.frame.timestamp_us - current.frame.timestamp_us) * factor),
            interpolated: true,
            ...(compressed === undefined ? {} : { compressed }),
            ...(releaseBlend === undefined ? {} : { releaseBlend }),
          });
        }
      }
      if (!byKey.has(key)) byKey.set(key, series);
    }
    return output.sort((a, b) => a.frame - b.frame || pointKey(a).localeCompare(pointKey(b)));
  }

  public fingertipSeries(): Record<string, FingerSample[]> {
    const series: Record<string, FingerSample[]> = {};
    for (const point of this.interpolateSemanticPoints()) {
      const key = pointKey(point);
      (series[key] ??= []).push({
        side: point.side,
        finger: point.finger,
        x: point.x,
        y: point.y,
        frame: point.frame,
        time: point.time,
        timestamp_us: point.timestamp_us,
        interpolated: point.interpolated,
        ...(point.compressed === undefined ? {} : { compressed: point.compressed }),
        ...(point.releaseBlend === undefined ? {} : { releaseBlend: point.releaseBlend }),
        ...(point.longGap ? { quality: 0 } : { quality: 1 }),
        ...(point.missing ? { missing: true, longGap: true } : {}),
      });
    }
    return series;
  }

  public palmSeries(): Record<'hand_1' | 'hand_2', PalmTrackSample[]> {
    const result: Record<'hand_1' | 'hand_2', PalmTrackSample[]> = { hand_1: [], hand_2: [] };
    for (const frame of this.semanticFrames) {
      const bySide = new Map(frame.palms.map((palm) => [palm.side, palm]));
      for (const side of HAND_IDS) {
        const palm = bySide.get(side);
        result[side].push({
          side,
          x: palm?.x ?? null,
          y: palm?.y ?? null,
          scale: palm?.scale ?? null,
          orientation: palm?.orientation ?? null,
          visible: Boolean(palm?.visible),
          frame: frame.frame,
          time: frame.time,
          timestamp_us: frame.timestamp_us,
          ...(palm?.identityAmbiguous ? { identityAmbiguous: true } : {}),
          ...(palm ? {} : { missing: true }),
        });
      }
    }
    return result;
  }

  public summary(): TrajectorySummary {
    const transitions = this.semanticFrames.flatMap((frame) => frame.transitions);
    const highestFrame = Math.max(highestFrameIndex(this.rawFrames), highestFrameIndex(this.semanticFrames));
    return {
      frameCount: highestFrame + 1,
      width: this.width,
      height: this.height,
      droppedFrames: this.rawFrames.filter((frame) => frame.flags?.dropped).length,
      duplicateFrames: this.rawFrames.filter((frame) => frame.flags?.duplicate).length,
      decodeGaps: this.rawFrames.filter((frame) => frame.flags?.decodeGap).length,
      identityAmbiguousFrames: this.semanticFrames.filter((frame) => frame.flags.identityAmbiguous).length,
      needsReviewFrames: new Set([
        ...this.rawFrames.filter((frame) => frame.flags?.needsReview).map((frame) => frame.frame),
        ...this.semanticFrames.filter((frame) => frame.flags.needsReview).map((frame) => frame.frame),
      ]).size,
      longGapFrames: this.semanticFrames.filter((frame) => frame.flags.longGap).length
        + this.interpolateSemanticPoints().filter((point) => point.longGap).length,
      missingSamples: this.interpolateSemanticPoints().filter((point) => point.missing).length,
      transitions,
    };
  }
}

export function createTrajectoryStore(options: TrajectoryStoreOptions = {}): TrajectoryStore {
  return new TrajectoryStore(options);
}
