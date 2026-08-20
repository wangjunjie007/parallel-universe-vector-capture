import {
  DEFAULT_TRACKING_CONFIG,
  FINGER_NAMES,
  LANDMARK_INDEX,
  type ExtendedSemanticPoint,
  type FingerName,
  type GestureState,
  type HandId,
  type IdentityFrameResult,
  type Point2D,
  type SemanticFrame,
  type SemanticPoint,
  type SemanticTransition,
  type TrackingConfig,
  type TrackedHand,
} from './types';
import { derivePalmMetrics, distance } from './identityTracker';

export interface SemanticProcessorOptions extends Partial<TrackingConfig> {}

export interface HandGestureEvidence {
  pinchGapNormalized: number;
  pinchRaw: boolean;
  pinchStable: boolean;
  extendedRaw: Record<FingerName, boolean>;
  extendedStable: Record<FingerName, boolean>;
  allOpenStable: boolean;
}

interface HandState {
  pinchStable: boolean;
  pinchTrueFrames: number;
  pinchFalseFrames: number;
  lastPinchGapNormalized: number;
  lastPinchRaw: boolean;
  lastExtendedRaw: Record<FingerName, boolean>;
  extensionTrueFrames: Record<FingerName, number>;
  extensionFalseFrames: Record<FingerName, number>;
  extendedStable: Record<FingerName, boolean>;
  compressedPair?: { thumb: Point2D; index: Point2D };
  releaseStart?: { thumb: Point2D; index: Point2D };
  releaseFramesRemaining: number;
  lastSeenFrame: number;
  disappearanceReported: boolean;
}

type GlobalPhase = 'none' | 'portal4' | 'portal10';

const DEFAULT_STATE: Record<FingerName, boolean> = {
  thumb: false,
  index: false,
  middle: false,
  ring: false,
  little: false,
};

function emptyState<T>(value: T): Record<FingerName, T> {
  return {
    thumb: value,
    index: value,
    middle: value,
    ring: value,
    little: value,
  };
}

function clonePoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y };
}

function strictPoint(point: ExtendedSemanticPoint): SemanticPoint {
  return { side: point.side, finger: point.finger, x: point.x, y: point.y };
}

function landmark(hand: TrackedHand, index: number): Point2D | undefined {
  const item = hand.landmarks.find((entry) => entry.index === index) ?? hand.landmarks[index];
  return item ? { x: item.source.x, y: item.source.y } : undefined;
}

interface Point3D extends Point2D { z: number }

function landmark3d(hand: TrackedHand, index: number): Point3D | undefined {
  const item = hand.landmarks.find((entry) => entry.index === index) ?? hand.landmarks[index];
  if (!item) return undefined;
  // MediaPipe z is normalized to roughly the same hand scale as x. Convert it
  // to source-pixel units so foreshortened fingers can use the detector's depth.
  return { x: item.source.x, y: item.source.y, z: (item.normalized.z ?? 0) * Math.max(hand.palmScale, 1) };
}

function angleAt(a: Point2D, vertex: Point2D, b: Point2D): number {
  const ax = a.x - vertex.x;
  const ay = a.y - vertex.y;
  const bx = b.x - vertex.x;
  const by = b.y - vertex.y;
  const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (denominator < 1e-6) return 0;
  const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / denominator));
  return (Math.acos(cosine) * 180) / Math.PI;
}

function distance3d(a: Point3D, b: Point3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function angleAt3d(a: Point3D, vertex: Point3D, b: Point3D): number {
  const ax = a.x - vertex.x;
  const ay = a.y - vertex.y;
  const az = a.z - vertex.z;
  const bx = b.x - vertex.x;
  const by = b.y - vertex.y;
  const bz = b.z - vertex.z;
  const denominator = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
  if (denominator < 1e-6) return 0;
  const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / denominator));
  return (Math.acos(cosine) * 180) / Math.PI;
}

function fingerTip(hand: TrackedHand, finger: FingerName): Point2D | undefined {
  const index = LANDMARK_INDEX[`${finger}_tip` as keyof typeof LANDMARK_INDEX];
  return typeof index === 'number' ? landmark(hand, index) : undefined;
}

function fingerExtended(hand: TrackedHand, finger: FingerName, palmScale: number): boolean {
  const wrist = landmark(hand, LANDMARK_INDEX.wrist);
  const tip = fingerTip(hand, finger);
  const wrist3d = landmark3d(hand, LANDMARK_INDEX.wrist);
  const tip3d = landmark3d(hand, LANDMARK_INDEX[`${finger}_tip` as keyof typeof LANDMARK_INDEX]);
  if (!wrist || !tip) return false;
  const scale = Math.max(palmScale, 1);
  if (finger === 'thumb') {
    const mcp = landmark(hand, LANDMARK_INDEX.thumb_mcp);
    const ip = landmark(hand, LANDMARK_INDEX.thumb_ip);
    const mcp3d = landmark3d(hand, LANDMARK_INDEX.thumb_mcp);
    const ip3d = landmark3d(hand, LANDMARK_INDEX.thumb_ip);
    if (!mcp || !ip) return false;
    const reach = distance(wrist, tip) / scale;
    const angle = angleAt(mcp, ip, tip);
    const depthReach = wrist3d && tip3d ? distance3d(wrist3d, tip3d) / scale : 0;
    const depthAngle = mcp3d && ip3d && tip3d ? angleAt3d(mcp3d, ip3d, tip3d) : 0;
    return (reach > 1.15 && angle > 125) || (depthReach > 1.2 && depthAngle > 120);
  }
  const prefix = finger === 'index' ? 'index' : finger === 'middle' ? 'middle' : finger === 'ring' ? 'ring' : 'little';
  const mcp = landmark(hand, LANDMARK_INDEX[`${prefix}_mcp` as keyof typeof LANDMARK_INDEX]);
  const pip = landmark(hand, LANDMARK_INDEX[`${prefix}_pip` as keyof typeof LANDMARK_INDEX]);
  const dip = landmark(hand, LANDMARK_INDEX[`${prefix}_dip` as keyof typeof LANDMARK_INDEX]);
  const mcp3d = landmark3d(hand, LANDMARK_INDEX[`${prefix}_mcp` as keyof typeof LANDMARK_INDEX]);
  const pip3d = landmark3d(hand, LANDMARK_INDEX[`${prefix}_pip` as keyof typeof LANDMARK_INDEX]);
  const dip3d = landmark3d(hand, LANDMARK_INDEX[`${prefix}_dip` as keyof typeof LANDMARK_INDEX]);
  const tip3dFinger = landmark3d(hand, LANDMARK_INDEX[`${prefix}_tip` as keyof typeof LANDMARK_INDEX]);
  if (!mcp || !pip || !dip) return false;
  const reach = distance(wrist, tip) / scale;
  const pipAngle = angleAt(mcp, pip, dip);
  const dipAngle = angleAt(pip, dip, tip);
  const depthReach = wrist3d && tip3d ? distance3d(wrist3d, tip3d) / scale : 0;
  const depthPipAngle = mcp3d && pip3d && dip3d ? angleAt3d(mcp3d, pip3d, dip3d) : 0;
  const depthDipAngle = pip3d && dip3d && tip3dFinger ? angleAt3d(pip3d, dip3d, tip3dFinger) : 0;
  return (reach > 1.28 && pipAngle > 145 && dipAngle > 145)
    || (depthReach > 1.3 && depthPipAngle > 135 && depthDipAngle > 135);
}

function allFalse<T extends Record<FingerName, boolean>>(values: T): boolean {
  return FINGER_NAMES.every((finger) => !values[finger]);
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function stateFromPhase(phase: GlobalPhase): GestureState {
  if (phase === 'portal10') return 'all_open';
  if (phase === 'portal4') return 'pinch';
  return 'none';
}

function makeHandState(): HandState {
  return {
    pinchStable: false,
    pinchTrueFrames: 0,
    pinchFalseFrames: 0,
    lastPinchGapNormalized: Number.POSITIVE_INFINITY,
    lastPinchRaw: false,
    lastExtendedRaw: { ...DEFAULT_STATE },
    extensionTrueFrames: emptyState(0),
    extensionFalseFrames: emptyState(0),
    extendedStable: { ...DEFAULT_STATE },
    releaseFramesRemaining: 0,
    lastSeenFrame: -1,
    disappearanceReported: false,
  };
}

function transition(type: SemanticTransition['type'], frame: IdentityFrameResult, side?: HandId, count?: number): SemanticTransition {
  return { type, frame: frame.frame, time: frame.time, ...(side ? { side } : {}), ...(count === undefined ? {} : { count }) };
}

/**
 * Gesture-aware semanticizer.  Raw detector observations are never modified;
 * this class only creates a second, contract-constrained layer.
 */
export class SemanticProcessor {
  public readonly config: TrackingConfig;
  private readonly handStates = new Map<HandId, HandState>([
    ['hand_1', makeHandState()],
    ['hand_2', makeHandState()],
  ]);
  private phase: GlobalPhase = 'none';
  private started = false;

  public constructor(options: SemanticProcessorOptions = {}) {
    this.config = {
      ...DEFAULT_TRACKING_CONFIG,
      ...options,
      confirmationFrames: Math.max(1, Math.round(options.confirmationFrames ?? DEFAULT_TRACKING_CONFIG.confirmationFrames)),
      pinchReleaseConfirmationFrames: Math.max(1, Math.round(options.pinchReleaseConfirmationFrames ?? DEFAULT_TRACKING_CONFIG.pinchReleaseConfirmationFrames)),
      pinchReleaseBlendFrames: Math.max(1, Math.round(options.pinchReleaseBlendFrames ?? DEFAULT_TRACKING_CONFIG.pinchReleaseBlendFrames)),
    };
  }

  public reset(): void {
    this.phase = 'none';
    this.started = false;
    for (const side of ['hand_1', 'hand_2'] as HandId[]) this.handStates.set(side, makeHandState());
  }

  public getPhase(): GlobalPhase {
    return this.phase;
  }

  public getHandEvidence(side: HandId): HandGestureEvidence | undefined {
    const state = this.handStates.get(side);
    if (!state) return undefined;
    return {
      pinchGapNormalized: state.lastPinchGapNormalized,
      pinchRaw: state.lastPinchRaw,
      pinchStable: state.pinchStable,
      extendedRaw: { ...state.lastExtendedRaw },
      extendedStable: { ...state.extendedStable },
      allOpenStable: FINGER_NAMES.every((finger) => state.extendedStable[finger]),
    };
  }

  /** Public pure-ish classifier useful for adapters and deterministic tests. */
  public classify(hand: TrackedHand): Omit<HandGestureEvidence, 'pinchStable' | 'extendedStable' | 'allOpenStable'> {
    const metrics = derivePalmMetrics(hand.landmarks);
    const thumb = fingerTip(hand, 'thumb');
    const index = fingerTip(hand, 'index');
    const gap = thumb && index ? distance(thumb, index) / Math.max(metrics.scale, 1) : Number.POSITIVE_INFINITY;
    const extendedRaw = {
      thumb: fingerExtended(hand, 'thumb', metrics.scale),
      index: fingerExtended(hand, 'index', metrics.scale),
      middle: fingerExtended(hand, 'middle', metrics.scale),
      ring: fingerExtended(hand, 'ring', metrics.scale),
      little: fingerExtended(hand, 'little', metrics.scale),
    } satisfies Record<FingerName, boolean>;
    return {
      pinchGapNormalized: gap,
      pinchRaw: gap <= this.config.pinchEnterNormalized,
      extendedRaw,
    };
  }

  private updateHandState(hand: TrackedHand, frame: number): { evidence: HandGestureEvidence; transitions: SemanticTransition[] } {
    const state = this.handStates.get(hand.side) ?? makeHandState();
    this.handStates.set(hand.side, state);
    const raw = this.classify(hand);
    state.lastPinchGapNormalized = raw.pinchGapNormalized;
    state.lastPinchRaw = raw.pinchRaw;
    state.lastExtendedRaw = { ...raw.extendedRaw };
    state.disappearanceReported = false;
    const transitions: SemanticTransition[] = [];
    const threshold = this.config.confirmationFrames;

    const pinchRaw = state.pinchStable ? raw.pinchGapNormalized <= this.config.pinchExitNormalized : raw.pinchRaw;
    if (pinchRaw) {
      state.pinchTrueFrames += 1;
      state.pinchFalseFrames = 0;
    } else {
      state.pinchFalseFrames += 1;
      state.pinchTrueFrames = 0;
    }
    if (!state.pinchStable && state.pinchTrueFrames >= threshold) {
      state.pinchStable = true;
      state.pinchFalseFrames = 0;
      transitions.push(transition('pinch_confirmed', {
        frame,
        time: 0,
        timestamp_us: 0,
        width: 0,
        height: 0,
        hands: [],
        identityAmbiguous: false,
        identityReset: [],
        unmatchedCandidates: [],
        diagnostics: [],
      }, hand.side));
    } else if (state.pinchStable && state.pinchFalseFrames >= this.config.pinchReleaseConfirmationFrames) {
      state.pinchStable = false;
      state.pinchTrueFrames = 0;
      state.releaseStart = state.compressedPair
        ? { thumb: clonePoint(state.compressedPair.thumb), index: clonePoint(state.compressedPair.index) }
        : undefined;
      state.releaseFramesRemaining = this.config.pinchReleaseBlendFrames;
      transitions.push(transition('pinch_released', {
        frame,
        time: 0,
        timestamp_us: 0,
        width: 0,
        height: 0,
        hands: [],
        identityAmbiguous: false,
        identityReset: [],
        unmatchedCandidates: [],
        diagnostics: [],
      }, hand.side));
    }

    for (const finger of FINGER_NAMES) {
      if (raw.extendedRaw[finger]) {
        state.extensionTrueFrames[finger] += 1;
        state.extensionFalseFrames[finger] = 0;
      } else {
        state.extensionFalseFrames[finger] += 1;
        state.extensionTrueFrames[finger] = 0;
      }
      if (!state.extendedStable[finger] && state.extensionTrueFrames[finger] >= threshold) state.extendedStable[finger] = true;
      if (state.extendedStable[finger] && state.extensionFalseFrames[finger] >= threshold) state.extendedStable[finger] = false;
    }
    state.lastSeenFrame = frame;
    return {
      evidence: {
        ...raw,
        pinchStable: state.pinchStable,
        extendedStable: { ...state.extendedStable },
        allOpenStable: FINGER_NAMES.every((finger) => state.extendedStable[finger]),
      },
      transitions,
    };
  }

  private compressedPair(hand: TrackedHand): { thumb: Point2D; index: Point2D } | undefined {
    const thumb = fingerTip(hand, 'thumb');
    const index = fingerTip(hand, 'index');
    if (!thumb || !index) return undefined;
    const gap = this.config.pinchGapPxAt1280 * (hand.palmScale > 0 ? 1 : 1);
    // Width scaling is applied by pointForFinger, where source width is known.
    const center = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    const vector = { x: index.x - thumb.x, y: index.y - thumb.y };
    const length = Math.hypot(vector.x, vector.y);
    const unit = length > 1e-6 ? { x: vector.x / length, y: vector.y / length } : { x: 1, y: 0 };
    return {
      thumb: { x: center.x - (unit.x * gap) / 2, y: center.y - (unit.y * gap) / 2 },
      index: { x: center.x + (unit.x * gap) / 2, y: center.y + (unit.y * gap) / 2 },
    };
  }

  private pointForFinger(
    hand: TrackedHand,
    finger: FingerName,
    width: number,
    state: HandState,
  ): (Point2D & Pick<ExtendedSemanticPoint, 'compressed' | 'releaseBlend'>) | undefined {
    const measured = fingerTip(hand, finger);
    if (!measured) return undefined;
    const isPinchPair = finger === 'thumb' || finger === 'index';
    if (!isPinchPair) return measured;
    if (state.pinchStable) {
      const pair = this.compressedPair(hand);
      if (!pair) return measured;
      const scaledGap = this.config.pinchGapPxAt1280 * (width / 1280);
      const currentGap = distance(pair.thumb, pair.index);
      const scale = currentGap > 1e-6 ? scaledGap / currentGap : 1;
      const center = { x: (pair.thumb.x + pair.index.x) / 2, y: (pair.thumb.y + pair.index.y) / 2 };
      const compressed = {
        thumb: { x: center.x + (pair.thumb.x - center.x) * scale, y: center.y + (pair.thumb.y - center.y) * scale },
        index: { x: center.x + (pair.index.x - center.x) * scale, y: center.y + (pair.index.y - center.y) * scale },
      };
      state.compressedPair = compressed;
      return { ...compressed[finger], compressed: true, releaseBlend: 0 };
    }
    if (state.releaseFramesRemaining > 0 && state.releaseStart) {
      const elapsed = this.config.pinchReleaseBlendFrames - state.releaseFramesRemaining + 1;
      const factor = smoothstep(elapsed / this.config.pinchReleaseBlendFrames);
      const start = state.releaseStart[finger];
      return {
        x: start.x + (measured.x - start.x) * factor,
        y: start.y + (measured.y - start.y) * factor,
        compressed: false,
        releaseBlend: factor,
      };
    }
    return { ...measured, compressed: false, releaseBlend: 1 };
  }

  private buildExtendedPoints(hands: TrackedHand[], evidence: Map<HandId, HandGestureEvidence>, width: number): ExtendedSemanticPoint[] {
    const points: ExtendedSemanticPoint[] = [];
    for (const hand of hands) {
      const state = this.handStates.get(hand.side) ?? makeHandState();
      const handEvidence = evidence.get(hand.side);
      if (!handEvidence) continue;
      const fingers: FingerName[] = [];
      for (const finger of FINGER_NAMES) {
        const visible = handEvidence.extendedStable[finger] || (finger === 'thumb' || finger === 'index') && (state.pinchStable || this.phase !== 'none');
        if (visible) fingers.push(finger);
      }
      for (const finger of fingers) {
        const point = this.pointForFinger(hand, finger, width, state);
        if (point) points.push({ side: hand.side, finger, ...point });
      }
    }
    return points;
  }

  public processFrame(input: IdentityFrameResult): SemanticFrame {
    const transitions: SemanticTransition[] = [];
    const evidence = new Map<HandId, HandGestureEvidence>();
    const seenSides = new Set<HandId>();

    // A long disappearance invalidates the previous temporal identity.  Reset
    // the corresponding gesture latch before consuming any candidate on this
    // frame, and restart the portal phase so stale points cannot be presented
    // as if they belonged to the newly observed hand.
    const resetSides = new Set(input.identityReset);
    if (resetSides.size > 0) {
      for (const side of resetSides) this.handStates.set(side, makeHandState());
      this.phase = 'none';
      this.started = false;
    }
    for (const hand of input.hands) {
      seenSides.add(hand.side);
      const updated = this.updateHandState(hand, input.frame);
      // updateHandState emits frame-independent transitions; normalize here.
      for (const item of updated.transitions) transitions.push({ ...item, frame: input.frame, time: input.time });
      evidence.set(hand.side, updated.evidence);
    }

    for (const side of ['hand_1', 'hand_2'] as HandId[]) {
      const state = this.handStates.get(side);
      if (state && this.phase !== 'none' && !seenSides.has(side) && state.lastSeenFrame >= 0) {
        if (!state.disappearanceReported) {
          transitions.push(transition('hand_disappeared', input, side));
          state.disappearanceReported = true;
        }
      }
    }
    if (input.identityReset.length > 0) {
      for (const side of input.identityReset) transitions.push(transition('identity_reset', input, side));
    }
    if (input.identityAmbiguous) transitions.push(transition('identity_ambiguous', input));

    const hand1 = evidence.get('hand_1');
    const hand2 = evidence.get('hand_2');
    if (!this.started && hand1?.pinchStable && hand2?.pinchStable) {
      this.started = true;
      this.phase = 'portal4';
      transitions.push(transition('tracking_started', input, undefined, 4));
    }
    // A pinch fixture can have straight detector chains while the fingers are
    // still touching.  Full-open is a post-release state, so require both
    // pinch latches to be released before promoting 4 -> 10.
    const bothHandsCurrentlyOpen = Boolean(
      hand1 && hand2
      && FINGER_NAMES.every((finger) => hand1.extendedRaw[finger] && hand2.extendedRaw[finger]),
    );
    if (this.phase === 'portal4' && !hand1?.pinchStable && !hand2?.pinchStable && hand1?.allOpenStable && hand2?.allOpenStable && bothHandsCurrentlyOpen) {
      this.phase = 'portal10';
      transitions.push(transition('all_open_confirmed', input, undefined, 10));
    }

    const extendedPoints = this.buildExtendedPoints(input.hands, evidence, input.width);
    let points: SemanticPoint[] = [];
    let count: 0 | 4 | 10 = 0;
    if (resetSides.size === 0 && !input.identityAmbiguous && seenSides.has('hand_1') && seenSides.has('hand_2')) {
      if (this.phase === 'portal4') {
        const bySide = new Map(extendedPoints.map((point) => [`${point.side}:${point.finger}`, point]));
        const required = ['hand_1:thumb', 'hand_1:index', 'hand_2:thumb', 'hand_2:index'];
        if (required.every((id) => bySide.has(id))) {
          points = required.map((id) => strictPoint(bySide.get(id) as ExtendedSemanticPoint));
          count = 4;
        }
      } else if (this.phase === 'portal10') {
        const bySide = new Map(extendedPoints.map((point) => [`${point.side}:${point.finger}`, point]));
        const required = (['hand_1', 'hand_2'] as HandId[]).flatMap((side) => FINGER_NAMES.map((finger) => `${side}:${finger}`));
        if (required.every((id) => bySide.has(id))) {
          points = required.map((id) => strictPoint(bySide.get(id) as ExtendedSemanticPoint));
          count = 10;
        }
      }
    }

    // A release blend is consumed only after the frame has been emitted.
    for (const state of this.handStates.values()) {
      if (!state.pinchStable && state.releaseFramesRemaining > 0) state.releaseFramesRemaining -= 1;
    }

    const flags = {
      ...(input.identityAmbiguous ? { identityAmbiguous: true, needsReview: true } : {}),
      ...(input.identityReset.length > 0 ? { identityReset: [...input.identityReset], needsReview: true } : {}),
      ...(input.hands.length < 2 && this.phase !== 'none' ? { needsReview: true } : {}),
      ...(this.phase === 'portal4' && count !== 4 ? { needsReview: true } : {}),
      ...(this.phase === 'portal10' && count !== 10 ? { needsReview: true } : {}),
      ...(input.diagnostics.length > 0 ? { errors: [...input.diagnostics] } : {}),
    };
    let outputState = stateFromPhase(this.phase);
    // The phase records the highest confirmed portal contract, while the
    // frame state describes what is actually safe to export on this frame.
    // If a hand closes or becomes unavailable after the ten-point phase, do
    // not emit an impossible `all_open` + non-ten combination.
    if (this.phase !== 'none' && count !== 4 && count !== 10) {
      outputState = extendedPoints.length > 0 ? 'partial_open' : 'none';
    }
    return {
      frame: input.frame,
      time: input.time,
      timestamp_us: input.timestamp_us,
      width: input.width,
      height: input.height,
      state: outputState,
      count,
      points,
      extendedPoints,
      palms: input.hands.map((hand) => ({
        side: hand.side,
        x: hand.palmCenter.x,
        y: hand.palmCenter.y,
        scale: hand.palmScale,
        orientation: hand.palmOrientation,
        visible: true,
        identityAmbiguous: hand.identityAmbiguous,
      })),
      transitions,
      flags,
    };
  }
}

export function createSemanticProcessor(options: SemanticProcessorOptions = {}): SemanticProcessor {
  return new SemanticProcessor(options);
}
