import {
  LANDMARK_NAMES,
  type GestureState,
  type RawHandCandidate,
  type RawLandmark,
} from '../../src/core';

export interface SyntheticHandOptions {
  candidateIndex?: number;
  centerX?: number;
  centerY?: number;
  gesture?: 'pinch' | 'open' | 'partial';
  handedness?: 'Left' | 'Right' | 'Unknown';
}

/** Deterministic 21-point hand fixture with source-pixel coordinates. */
export function makeHand(options: SyntheticHandOptions = {}): RawHandCandidate {
  const cx = options.centerX ?? 320;
  const cy = options.centerY ?? 260;
  const gesture = options.gesture ?? 'pinch';
  const pinch = gesture === 'pinch';
  const points: Array<{ x: number; y: number }> = [
    { x: cx, y: cy + 80 }, // wrist
    { x: cx - 30, y: cy + 65 }, // thumb cmc
    { x: cx - 55, y: cy + 45 }, // thumb mcp
    { x: cx - 70, y: cy + 15 }, // thumb ip
    { x: pinch ? cx - 31 : cx - 105, y: pinch ? cy - 68 : cy - 15 }, // thumb tip
    { x: cx - 30, y: cy + 20 }, // index mcp
    { x: cx - 30, y: cy - 10 }, // index pip
    { x: cx - 30, y: cy - 40 }, // index dip
    { x: cx - 30, y: cy - 68 }, // index tip
    { x: cx, y: cy + 15 }, // middle mcp
    { x: cx, y: cy - 20 }, // middle pip
    { x: cx, y: cy - 55 }, // middle dip
    { x: cx, y: gesture === 'partial' ? cy + 2 : cy - 82 }, // middle tip
    { x: cx + 30, y: cy + 20 }, // ring mcp
    { x: cx + 30, y: cy - 5 }, // ring pip
    { x: cx + 30, y: cy - 30 }, // ring dip
    { x: cx + 30, y: gesture === 'partial' ? cy + 4 : cy - 70 }, // ring tip
    { x: cx + 55, y: cy + 25 }, // little mcp
    { x: cx + 55, y: cy + 2 }, // little pip
    { x: cx + 55, y: cy - 20 }, // little dip
    { x: cx + 55, y: gesture === 'partial' ? cy + 7 : cy - 58 }, // little tip
  ];
  const landmarks: RawLandmark[] = points.map((point, index) => ({
    index,
    name: LANDMARK_NAMES[index] ?? `landmark_${index}`,
    normalized: { x: point.x / 1280, y: point.y / 720, z: 0 },
    source: point,
  }));
  return {
    candidateIndex: options.candidateIndex ?? 0,
    landmarks,
    handedness: options.handedness ?? 'Unknown',
    confidence: 0.98,
  };
}

export function makeIdentityFrame(
  frame: number,
  hands: RawHandCandidate[],
  width = 1280,
  height = 720,
): {
  frame: number;
  time: number;
  timestamp_us: number;
  width: number;
  height: number;
  candidates: RawHandCandidate[];
} {
  return { frame, time: frame / 30, timestamp_us: Math.round((frame / 30) * 1_000_000), width, height, candidates: hands };
}

export function makeSemanticPointFrame(frame: number, count: 0 | 4 | 10, state: GestureState = count === 10 ? 'all_open' : count === 4 ? 'pinch' : 'none') {
  const ids = count === 4
    ? [['hand_1', 'thumb'], ['hand_1', 'index'], ['hand_2', 'thumb'], ['hand_2', 'index']]
    : count === 10
      ? (['hand_1', 'hand_2'] as const).flatMap((side) => (['thumb', 'index', 'middle', 'ring', 'little'] as const).map((finger) => [side, finger] as const))
      : [];
  const points = ids.map(([side, finger], index) => ({ side, finger, x: 100 + index * 20 + frame * 10, y: 200 + index * 3 }));
  return {
    frame,
    time: frame / 30,
    timestamp_us: Math.round((frame / 30) * 1_000_000),
    width: 1280,
    height: 720,
    state,
    count,
    points,
    extendedPoints: points,
    palms: [
      { side: 'hand_1' as const, x: 200, y: 300, scale: 70, orientation: 0, visible: true },
      { side: 'hand_2' as const, x: 700, y: 300, scale: 70, orientation: 0, visible: true },
    ],
    transitions: [],
    flags: {},
  };
}
