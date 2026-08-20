import {
  DEFAULT_TRACKING_CONFIG,
  HAND_IDS,
  LANDMARK_INDEX,
  type HandId,
  type IdentityFrameInput,
  type IdentityFrameResult,
  type Point2D,
  type RawHandCandidate,
  type RawLandmark,
  type TrackedHand,
} from './types';

export interface PalmMetrics {
  center: Point2D;
  wrist: Point2D;
  scale: number;
  orientation: number;
}

export interface IdentityTrackerOptions {
  maxIdentityGapFrames?: number;
  ambiguityMargin?: number;
  maxMatchDistanceScales?: number;
}

interface TrackMemory extends PalmMetrics {
  side: HandId;
  velocity: Point2D;
  lastFrame: number;
  missingFrames: number;
  handedness?: RawHandCandidate['handedness'];
}

interface Assignment {
  sides: Array<HandId | null>;
  cost: number;
}

const EPSILON = 1e-6;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function landmarkAt(landmarks: RawLandmark[], index: number): Point2D | undefined {
  const landmark = landmarks.find((item) => item.index === index) ?? landmarks[index];
  if (!landmark) return undefined;
  return { x: finite(landmark.source.x), y: finite(landmark.source.y) };
}

function average(points: Point2D[]): Point2D {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

/** Derive hand-level metrics without modifying the raw landmarks. */
export function derivePalmMetrics(landmarks: RawLandmark[]): PalmMetrics {
  const wrist = landmarkAt(landmarks, LANDMARK_INDEX.wrist) ?? { x: 0, y: 0 };
  const palmJoints = [
    landmarkAt(landmarks, LANDMARK_INDEX.index_mcp),
    landmarkAt(landmarks, LANDMARK_INDEX.middle_mcp),
    landmarkAt(landmarks, LANDMARK_INDEX.ring_mcp),
    landmarkAt(landmarks, LANDMARK_INDEX.little_mcp),
  ].filter((point): point is Point2D => Boolean(point));
  const center = average([wrist, ...palmJoints]);
  const radii = palmJoints.map((point) => distance(wrist, point)).filter((value) => value > EPSILON);
  const scale = radii.length > 0 ? radii.reduce((sum, value) => sum + value, 0) / radii.length : 1;
  const indexMcp = landmarkAt(landmarks, LANDMARK_INDEX.index_mcp) ?? center;
  const littleMcp = landmarkAt(landmarks, LANDMARK_INDEX.little_mcp) ?? center;
  const orientation = Math.atan2(indexMcp.y - littleMcp.y, indexMcp.x - littleMcp.x);
  return { center, wrist, scale: Math.max(scale, EPSILON), orientation };
}

function cloneCandidate(candidate: RawHandCandidate): RawHandCandidate {
  return {
    candidateIndex: candidate.candidateIndex,
    handedness: candidate.handedness,
    confidence: candidate.confidence,
    landmarks: candidate.landmarks.map((landmark) => ({
      index: landmark.index,
      name: landmark.name,
      normalized: { ...landmark.normalized },
      source: { ...landmark.source },
    })),
  };
}

function sideCost(candidate: PalmMetrics & RawHandCandidate, memory: TrackMemory, frame: number, maxMatchDistanceScales = Number.POSITIVE_INFINITY): number {
  const deltaFrames = Math.max(1, frame - memory.lastFrame);
  const predicted = {
    x: memory.center.x + memory.velocity.x * deltaFrames,
    y: memory.center.y + memory.velocity.y * deltaFrames,
  };
  const normalizer = Math.max(memory.scale, candidate.scale, 1);
  const motionCost = distance(candidate.center, predicted) / normalizer;
  // A candidate that is many palm-lengths away is more likely to be a new
  // hand (or a detector outlier) than the existing track.  Returning a large
  // cost lets the assignment solver choose the explicit unmatched branch.
  if (motionCost > maxMatchDistanceScales) return 4 + motionCost;
  const scaleCost = Math.abs(Math.log(Math.max(candidate.scale, EPSILON) / Math.max(memory.scale, EPSILON)));
  const handednessCost =
    memory.handedness && candidate.handedness && memory.handedness !== 'Unknown' && candidate.handedness !== 'Unknown' && memory.handedness !== candidate.handedness
      ? 0.32
      : 0;
  return motionCost + scaleCost * 0.2 + handednessCost;
}

function allAssignments(candidateCount: number): Array<Array<HandId | null>> {
  if (candidateCount <= 0) return [[]];
  if (candidateCount === 1) return [[HAND_IDS[0]], [HAND_IDS[1]], [null]];
  if (candidateCount === 2) {
    return [
      [HAND_IDS[0], HAND_IDS[1]],
      [HAND_IDS[1], HAND_IDS[0]],
      [HAND_IDS[0], null],
      [null, HAND_IDS[1]],
      [HAND_IDS[1], null],
      [null, HAND_IDS[0]],
    ];
  }
  // A detector configured with numHands=2 should never produce this, but do
  // not silently select arbitrary candidates if a browser adapter misbehaves.
  return [Array.from({ length: candidateCount }, () => null)];
}

function compareAssignments(a: Assignment, b: Assignment): number {
  return a.cost - b.cost;
}

/**
 * Maintains hand_1/hand_2 using temporal motion.  Handedness and screen side
 * only influence initialization or a small tie-break cost; they never replace
 * temporal matching.
 */
export class IdentityTracker {
  private readonly maxIdentityGapFrames: number;
  private readonly ambiguityMargin: number;
  private readonly maxMatchDistanceScales: number;
  private memories = new Map<HandId, TrackMemory>();

  public constructor(options: IdentityTrackerOptions = {}) {
    this.maxIdentityGapFrames = Math.max(0, Math.floor(options.maxIdentityGapFrames ?? DEFAULT_TRACKING_CONFIG.maxIdentityGapFrames));
    this.ambiguityMargin = Math.max(0, options.ambiguityMargin ?? 0.18);
    this.maxMatchDistanceScales = Math.max(0, options.maxMatchDistanceScales ?? 3.5);
  }

  public reset(): void {
    this.memories.clear();
  }

  public getMemory(): ReadonlyMap<HandId, TrackMemory> {
    return this.memories;
  }

  public update(input: IdentityFrameInput): IdentityFrameResult {
    const timestamp_us = input.timestamp_us ?? Math.round(input.time * 1_000_000);
    const diagnostics: string[] = [];
    const identityReset: HandId[] = [];
    const candidates = input.candidates
      .map((candidate) => {
        const copy = cloneCandidate(candidate);
        return Object.assign(copy, derivePalmMetrics(copy.landmarks));
      });
    if (candidates.length > HAND_IDS.length) diagnostics.push(`candidate_overflow:${candidates.length}`);

    // The first usable frame has no temporal identity.  Screen-left/right is
    // used only for this initialization hint; every later frame is matched by
    // predicted motion and palm scale.
    if (this.memories.size === 0 && candidates.length === 2) {
      candidates.sort((a, b) => a.center.x - b.center.x);
    }

    // Expire a side only after a bounded gap.  During the short gap it simply
    // has no semantic output; retaining memory allows a clean reconnection.
    for (const side of HAND_IDS) {
      const memory = this.memories.get(side);
      if (!memory) continue;
      const gap = input.frame - memory.lastFrame;
      if (gap > this.maxIdentityGapFrames) {
        this.memories.delete(side);
        identityReset.push(side);
        diagnostics.push(`${side}:identity_reset`);
      }
    }

    if (candidates.length === 0) {
      for (const memory of this.memories.values()) memory.missingFrames += 1;
      return {
        frame: input.frame,
        time: input.time,
        timestamp_us,
        width: input.width,
        height: input.height,
        hands: [],
        identityAmbiguous: false,
        identityReset,
        unmatchedCandidates: [],
        diagnostics,
      };
    }

    const assignments = allAssignments(candidates.length)
      .map((sides) => {
        let cost = 0;
        for (let i = 0; i < candidates.length; i += 1) {
          const side = sides[i];
          if (!side) {
            cost += 1.4;
            continue;
          }
          const memory = this.memories.get(side);
          if (memory) {
            const candidate = candidates[i];
            cost += sideCost(candidate, memory, input.frame, this.maxMatchDistanceScales);
          } else {
            // New sides are assigned by x-order when no temporal memory exists.
            cost += 0.05;
          }
        }
        return { sides, cost };
      })
      .sort(compareAssignments);

    let best = assignments[0];
    const second = assignments[1];
    let ambiguous = false;
    if (second && second.cost - best.cost < this.ambiguityMargin) {
      // If the candidates are genuinely indistinguishable, preserve the
      // previous mapping where possible and mark the frame for review.
      ambiguous = Boolean([...this.memories.values()].length > 0);
      if (ambiguous) {
        const preserved = candidates.map((candidate) => {
          let selected: HandId | null = null;
          let selectedCost = Number.POSITIVE_INFINITY;
          for (const side of HAND_IDS) {
            const memory = this.memories.get(side);
            if (!memory) continue;
            const cost = sideCost(candidate, memory, input.frame, this.maxMatchDistanceScales);
            if (cost < selectedCost) {
              selected = side;
              selectedCost = cost;
            }
          }
          return selected;
        });
        if (new Set(preserved.filter((side): side is HandId => Boolean(side))).size === candidates.length) {
          best = { sides: preserved, cost: best.cost };
        }
      }
    }

    const hands: TrackedHand[] = [];
    const usedSides = new Set<HandId>();
    const unmatchedCandidates: number[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const side = best.sides[i];
      if (!side || usedSides.has(side)) {
        unmatchedCandidates.push(candidate.candidateIndex);
        continue;
      }
      const metrics = candidate as RawHandCandidate & PalmMetrics;
      const previous = this.memories.get(side);
      const deltaFrames = previous ? Math.max(1, input.frame - previous.lastFrame) : 1;
      const velocity = previous
        ? {
            x: (metrics.center.x - previous.center.x) / deltaFrames,
            y: (metrics.center.y - previous.center.y) / deltaFrames,
          }
        : { x: 0, y: 0 };
      const identityAmbiguous = ambiguous;
      const tracked: TrackedHand = {
        ...cloneCandidate(candidate),
        side,
        palmCenter: { ...metrics.center },
        wrist: { ...metrics.wrist },
        palmScale: metrics.scale,
        palmOrientation: metrics.orientation,
        identityAmbiguous,
      };
      hands.push(tracked);
      usedSides.add(side);
      this.memories.set(side, {
        side,
        center: { ...metrics.center },
        wrist: { ...metrics.wrist },
        scale: metrics.scale,
        orientation: metrics.orientation,
        velocity,
        lastFrame: input.frame,
        missingFrames: 0,
        handedness: candidate.handedness,
      });
    }

    for (const side of HAND_IDS) {
      if (!usedSides.has(side)) {
        const memory = this.memories.get(side);
        if (memory) memory.missingFrames += 1;
      }
    }

    if (ambiguous) diagnostics.push('identity_ambiguous');
    if (unmatchedCandidates.length > 0) diagnostics.push('candidate_unmatched');
    return {
      frame: input.frame,
      time: input.time,
      timestamp_us,
      width: input.width,
      height: input.height,
      hands,
      identityAmbiguous: ambiguous,
      identityReset,
      unmatchedCandidates,
      diagnostics,
    };
  }
}

export function createIdentityTracker(options: IdentityTrackerOptions = {}): IdentityTracker {
  return new IdentityTracker(options);
}
