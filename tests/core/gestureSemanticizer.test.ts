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
  it('uses landmark depth when an extended finger points directly at the camera', () => {
    const hand = makeHand({ gesture: 'open' });
    for (const index of [5, 6, 7, 8]) {
      const landmark = hand.landmarks[index];
      landmark.source = { x: 320, y: 260 };
      landmark.normalized = { x: 0.25, y: 0.36, z: -(index - 4) * 0.7 };
    }
    const tracker = new IdentityTracker();
    const identity = tracker.update(makeIdentityFrame(0, [hand]));
    const evidence = createSemanticProcessor().classify(identity.hands[0]);
    expect(evidence.extendedRaw.index).toBe(true);
  });

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
    const extendedHand1 = last.extendedPoints.filter((point) => point.side === 'hand_1');
    const extendedPinchPair = extendedHand1.filter((point) => point.finger === 'thumb' || point.finger === 'index');
    expect(extendedPinchPair).toHaveLength(2);
    expect(extendedPinchPair.every((point) => point.compressed === true && point.releaseBlend === 0)).toBe(true);
    expect(last.points.every((point) => !('compressed' in point) && !('releaseBlend' in point))).toBe(true);
  });

  it('scales the compressed pinch gap by source width', () => {
    const tracker = new IdentityTracker();
    const processor = createSemanticProcessor();
    let last = runFrame(tracker, processor, 0, 'pinch');
    // The fixture coordinates are source pixels; only the declared source
    // width changes, so the semantic gap should follow the contract scaling.
    for (let frame = 1; frame < 6; frame += 1) {
      const identity = tracker.update(makeIdentityFrame(frame, [
        makeHand({ candidateIndex: frame * 2, centerX: 260, gesture: 'pinch' }),
        makeHand({ candidateIndex: frame * 2 + 1, centerX: 900, gesture: 'pinch' }),
      ], 640, 720));
      last = processor.processFrame(identity);
    }
    const hand1 = last.extendedPoints.filter((point) => point.side === 'hand_1');
    expect(Math.hypot(hand1[0].x - hand1[1].x, hand1[0].y - hand1[1].y)).toBeCloseTo(0.75, 5);
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
    for (let frame = 6; frame < 12; frame += 1) runFrame(tracker, processor, frame, 'open');
    const first = runFrame(tracker, processor, 12, 'open');
    const firstThumb = first.extendedPoints.find((point) => point.side === 'hand_1' && point.finger === 'thumb');
    expect(firstThumb).toMatchObject({ compressed: false });
    expect(firstThumb?.releaseBlend).toBeGreaterThan(0);
    expect(firstThumb?.releaseBlend).toBeLessThan(1);
    const samples = [firstThumb?.x ?? 0];
    const blends = [firstThumb?.releaseBlend ?? 0];
    for (let frame = 13; frame < 30; frame += 1) {
      const next = runFrame(tracker, processor, frame, 'open');
      const thumb = next.extendedPoints.find((point) => point.side === 'hand_1' && point.finger === 'thumb');
      expect(thumb).toBeDefined();
      samples.push(thumb?.x ?? 0);
      blends.push(thumb?.releaseBlend ?? 0);
    }
    expect(blends).toEqual([...blends].sort((a, b) => a - b));
    expect(blends.at(-1)).toBe(1);
    expect(samples[0]).not.toBeCloseTo(samples.at(-1) ?? 0, 3);
    expect(first.points.every((point) => !('compressed' in point) && !('releaseBlend' in point))).toBe(true);
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
