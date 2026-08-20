import { describe, expect, it } from 'vitest';
import { IdentityTracker, createSemanticProcessor } from '../../src/core';
import { makeHand, makeIdentityFrame } from './fixtures';

function runFrame(tracker: IdentityTracker, processor: ReturnType<typeof createSemanticProcessor>, frame: number, gesture: 'pinch' | 'open' | 'partial') {
  const identity = tracker.update(makeIdentityFrame(frame, [
    makeHand({ candidateIndex: frame * 2, centerX: 260, gesture }),
    makeHand({ candidateIndex: frame * 2 + 1, centerX: 900, gesture }),
  ]));
  return processor.processFrame(identity);
}

describe('SemanticProcessor', () => {
  it('confirms both-hand pinch after six frames and emits strict four points', () => {
    const tracker = new IdentityTracker();
    const processor = createSemanticProcessor();
    let last = runFrame(tracker, processor, 0, 'pinch');
    for (let frame = 1; frame < 6; frame += 1) last = runFrame(tracker, processor, frame, 'pinch');
    expect(last.count).toBe(4);
    expect(last.state).toBe('pinch');
    expect(last.points).toHaveLength(4);
    expect(new Set(last.points.map((point) => `${point.side}:${point.finger}`)).size).toBe(4);
    const hand1 = last.points.filter((point) => point.side === 'hand_1');
    expect(Math.hypot(hand1[0].x - hand1[1].x, hand1[0].y - hand1[1].y)).toBeCloseTo(1.5, 5);
  });

  it('keeps partial-open fingertips in extended output while strict output remains four', () => {
    const tracker = new IdentityTracker();
    const processor = createSemanticProcessor();
    for (let frame = 0; frame < 6; frame += 1) runFrame(tracker, processor, frame, 'pinch');
    let partial = runFrame(tracker, processor, 6, 'partial');
    for (let frame = 7; frame < 12; frame += 1) partial = runFrame(tracker, processor, frame, 'partial');
    expect(partial.count).toBe(4);
    expect(partial.extendedPoints.length).toBeGreaterThanOrEqual(4);
    expect(partial.state).toBe('pinch');
  });

  it('eases released pinch points toward measured tips instead of snapping', () => {
    const tracker = new IdentityTracker();
    const processor = createSemanticProcessor({ pinchReleaseBlendFrames: 18 });
    for (let frame = 0; frame < 6; frame += 1) runFrame(tracker, processor, frame, 'pinch');
    const before = runFrame(tracker, processor, 6, 'open');
    const first = before.points.find((point) => point.side === 'hand_1' && point.finger === 'thumb');
    const later = runFrame(tracker, processor, 7, 'open');
    const laterThumb = later.extendedPoints.find((point) => point.side === 'hand_1' && point.finger === 'thumb');
    expect(first).toBeDefined();
    expect(laterThumb).toBeDefined();
    expect(Number.isFinite(laterThumb?.x)).toBe(true);
  });

  it('does not emit semantic points while identities are ambiguous', () => {
    const tracker = new IdentityTracker({ ambiguityMargin: 0.5 });
    const processor = createSemanticProcessor();
    for (let frame = 0; frame < 6; frame += 1) runFrame(tracker, processor, frame, 'pinch');
    const ambiguousIdentity = tracker.update(makeIdentityFrame(6, [
      makeHand({ candidateIndex: 100, centerX: 578, gesture: 'pinch' }),
      makeHand({ candidateIndex: 101, centerX: 582, gesture: 'pinch' }),
    ]));
    const frame = processor.processFrame(ambiguousIdentity);
    expect(frame.count).toBe(0);
    expect(frame.points).toEqual([]);
    expect(frame.flags.needsReview).toBe(true);
  });

  it('resets stale gesture latches after an identity reset', () => {
    const tracker = new IdentityTracker({ maxIdentityGapFrames: 1 });
    const processor = createSemanticProcessor();
    for (let frame = 0; frame < 6; frame += 1) runFrame(tracker, processor, frame, 'pinch');
    expect(processor.getPhase()).toBe('portal4');

    const reset = tracker.update(makeIdentityFrame(8, []));
    const resetSemantic = processor.processFrame(reset);
    expect(reset.identityReset).toEqual(['hand_1', 'hand_2']);
    expect(resetSemantic.count).toBe(0);
    expect(resetSemantic.state).toBe('none');
    expect(resetSemantic.flags.needsReview).toBe(true);
    expect(processor.getHandEvidence('hand_1')?.pinchStable).toBe(false);
    expect(processor.getHandEvidence('hand_1')?.pinchGapNormalized).toBe(Infinity);
  });
});
