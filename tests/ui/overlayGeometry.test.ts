import { describe, expect, it } from 'vitest';
import { buildEffectRegions, FINGER_ORDER } from '../../src/ui/overlayGeometry';

const positions = new Map(FINGER_ORDER.flatMap((finger, index) => [
  [`hand_1:${finger}`, { x: index * 10, y: 10 }] as const,
  [`hand_2:${finger}`, { x: index * 10, y: 80 }] as const,
]));

describe('overlay effect region topology', () => {
  it('builds four stable adjacent-finger cells for ten points', () => {
    const regions = buildEffectRegions(positions, false, true);
    expect(regions.map((region) => region.id)).toEqual([
      'thumb-index',
      'index-middle',
      'middle-ring',
      'ring-little',
    ]);
    expect(regions.every((region) => region.corners.length === 4)).toBe(true);
  });

  it('deduplicates the pinch portal when multi-point cells are also enabled', () => {
    expect(buildEffectRegions(positions, true, true)).toHaveLength(4);
  });

  it('does not invent cells across a missing finger identity', () => {
    const partial = new Map(positions);
    partial.delete('hand_2:middle');
    expect(buildEffectRegions(partial, false, true).map((region) => region.id)).toEqual([
      'thumb-index',
      'ring-little',
    ]);
  });
});
