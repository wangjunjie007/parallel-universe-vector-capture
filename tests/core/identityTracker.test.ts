import { describe, expect, it } from 'vitest';
import { IdentityTracker, derivePalmMetrics } from '../../src/core';
import { makeHand, makeIdentityFrame } from './fixtures';

describe('IdentityTracker', () => {
  it('initialises by screen position and then preserves identity across detector order changes', () => {
    const tracker = new IdentityTracker({ ambiguityMargin: 0.05 });
    const left = makeHand({ candidateIndex: 10, centerX: 260 });
    const right = makeHand({ candidateIndex: 11, centerX: 900 });
    const first = tracker.update(makeIdentityFrame(0, [right, left]));
    expect(first.hands.map((hand) => [hand.side, hand.candidateIndex])).toEqual([
      ['hand_1', 10],
      ['hand_2', 11],
    ]);

    const second = tracker.update(makeIdentityFrame(1, [
      makeHand({ candidateIndex: 21, centerX: 895 }),
      makeHand({ candidateIndex: 20, centerX: 270 }),
    ]));
    expect(second.hands.find((hand) => hand.side === 'hand_1')?.candidateIndex).toBe(20);
    expect(second.hands.find((hand) => hand.side === 'hand_2')?.candidateIndex).toBe(21);
  });

  it('marks a close crossing assignment as ambiguous instead of silently swapping', () => {
    const tracker = new IdentityTracker({ ambiguityMargin: 0.5 });
    const first = tracker.update(makeIdentityFrame(0, [makeHand({ centerX: 450 }), makeHand({ centerX: 830, candidateIndex: 1 })]));
    expect(first.identityAmbiguous).toBe(false);
    const crossing = tracker.update(makeIdentityFrame(1, [
      makeHand({ centerX: 635, candidateIndex: 2 }),
      makeHand({ centerX: 645, candidateIndex: 3 }),
    ]));
    expect(crossing.identityAmbiguous).toBe(true);
    expect(crossing.hands.every((hand) => hand.identityAmbiguous)).toBe(true);
  });

  it('expires an identity only after the configured long gap', () => {
    const tracker = new IdentityTracker({ maxIdentityGapFrames: 2 });
    tracker.update(makeIdentityFrame(0, [makeHand({ centerX: 400 })]));
    const shortGap = tracker.update(makeIdentityFrame(2, []));
    expect(shortGap.identityReset).toEqual([]);
    const longGap = tracker.update(makeIdentityFrame(3, []));
    expect(longGap.identityReset).toEqual(['hand_1']);
  });

  it('derives source-pixel palm metrics without mutating landmarks', () => {
    const hand = makeHand({ centerX: 400 });
    const before = JSON.stringify(hand.landmarks);
    const metrics = derivePalmMetrics(hand.landmarks);
    expect(metrics.scale).toBeGreaterThan(0);
    expect(metrics.center.x).toBeGreaterThan(300);
    expect(JSON.stringify(hand.landmarks)).toBe(before);
  });

  it('fails closed on detector overflow instead of silently dropping candidates', () => {
    const tracker = new IdentityTracker();
    const result = tracker.update(makeIdentityFrame(0, [
      makeHand({ candidateIndex: 1, centerX: 200 }),
      makeHand({ candidateIndex: 2, centerX: 600 }),
      makeHand({ candidateIndex: 3, centerX: 1000 }),
    ]));
    expect(result.hands).toHaveLength(0);
    expect(result.unmatchedCandidates).toEqual([1, 2, 3]);
    expect(result.diagnostics).toContain('candidate_overflow:3');
  });

  it('does not attach a distant detector outlier to an existing identity', () => {
    const tracker = new IdentityTracker({ maxMatchDistanceScales: 2 });
    tracker.update(makeIdentityFrame(0, [makeHand({ candidateIndex: 1, centerX: 300 })]));
    const result = tracker.update(makeIdentityFrame(1, [makeHand({ candidateIndex: 2, centerX: 1100 })]));
    expect(result.hands.find((hand) => hand.side === 'hand_1')).toBeUndefined();
    expect(result.hands.find((hand) => hand.side === 'hand_2')?.candidateIndex).toBe(2);
  });
});
