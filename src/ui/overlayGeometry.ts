import type { UiPoint } from './types';

export interface OverlayPosition { x: number; y: number }
export interface EffectRegion { id: string; corners: [OverlayPosition, OverlayPosition, OverlayPosition, OverlayPosition] }

export const FINGER_ORDER: UiPoint['finger'][] = ['thumb', 'index', 'middle', 'ring', 'little'];

/** Build only identity-stable cells between adjacent fingers on both hands. */
export function buildEffectRegions(
  positions: ReadonlyMap<string, OverlayPosition>,
  includePortal: boolean,
  includeMultiPointCells: boolean,
): EffectRegion[] {
  const regions = new Map<string, EffectRegion>();
  const addCell = (leftFinger: UiPoint['finger'], rightFinger: UiPoint['finger']) => {
    const corners = [
      positions.get(`hand_1:${leftFinger}`),
      positions.get(`hand_1:${rightFinger}`),
      positions.get(`hand_2:${rightFinger}`),
      positions.get(`hand_2:${leftFinger}`),
    ];
    if (corners.every(Boolean)) {
      const id = `${leftFinger}-${rightFinger}`;
      regions.set(id, { id, corners: corners as EffectRegion['corners'] });
    }
  };

  if (includePortal) addCell('thumb', 'index');
  if (includeMultiPointCells) {
    for (let index = 0; index + 1 < FINGER_ORDER.length; index += 1) {
      addCell(FINGER_ORDER[index], FINGER_ORDER[index + 1]);
    }
  }
  return [...regions.values()];
}
