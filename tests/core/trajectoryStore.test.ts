import { describe, expect, it } from 'vitest';
import { createTrajectoryStore } from '../../src/core';
import { makeSemanticPointFrame } from './fixtures';

describe('TrajectoryStore', () => {
  it('fills only short gaps and marks long gaps as review data', () => {
    const store = createTrajectoryStore({ shortGapFrames: 2 });
    store.appendSemanticFrame(makeSemanticPointFrame(0, 4));
    store.appendSemanticFrame(makeSemanticPointFrame(2, 4));
    store.appendSemanticFrame(makeSemanticPointFrame(8, 4));
    const samples = store.interpolateSemanticPoints().filter((point) => point.side === 'hand_1' && point.finger === 'thumb');
    expect(samples.some((point) => point.frame === 1 && point.interpolated)).toBe(true);
    expect(samples.some((point) => point.frame === 3 && point.longGap)).toBe(true);
    expect(samples.some((point) => point.frame === 7 && point.longGap)).toBe(true);
    expect(samples.find((point) => point.frame === 1)?.x).toBeCloseTo(110);
  });

  it('carries pinch metadata through observations and short-gap interpolation', () => {
    const store = createTrajectoryStore({ shortGapFrames: 1 });
    const first = makeSemanticPointFrame(0, 4);
    const second = makeSemanticPointFrame(2, 4);
    first.extendedPoints = first.extendedPoints.map((point) => ({ ...point, compressed: true, releaseBlend: 0 }));
    second.extendedPoints = second.extendedPoints.map((point) => ({ ...point, compressed: false, releaseBlend: 1 }));
    store.appendSemanticFrame(first);
    store.appendSemanticFrame(second);

    const samples = store.fingertipSeries()['hand_1:thumb'];
    expect(samples).toHaveLength(3);
    expect(samples[0]).toMatchObject({ compressed: true, releaseBlend: 0 });
    expect(samples[1]).toMatchObject({ interpolated: true, compressed: false, releaseBlend: 0.5 });
    expect(samples[2]).toMatchObject({ compressed: false, releaseBlend: 1 });
  });

  it('does not fabricate pinch metadata across a long gap', () => {
    const store = createTrajectoryStore({ shortGapFrames: 1 });
    const first = makeSemanticPointFrame(0, 4);
    const second = makeSemanticPointFrame(3, 4);
    first.extendedPoints = first.extendedPoints.map((point) => ({ ...point, compressed: true, releaseBlend: 0 }));
    second.extendedPoints = second.extendedPoints.map((point) => ({ ...point, compressed: false, releaseBlend: 1 }));
    store.appendSemanticFrame(first);
    store.appendSemanticFrame(second);

    const samples = store.fingertipSeries()['hand_1:thumb'];
    expect(samples[1]).toMatchObject({ missing: true, longGap: true, x: null, y: null });
    expect(samples[1]).not.toHaveProperty('compressed');
    expect(samples[1]).not.toHaveProperty('releaseBlend');
  });

  it('keeps raw and semantic layers separate and can clear all session resources', () => {
    const store = createTrajectoryStore({ maxFrames: 2 });
    const raw = {
      frame: 0,
      time: 0,
      timestamp_us: 0,
      width: 1280,
      height: 720,
      hands: [],
    };
    store.appendRawFrame(raw);
    expect(store.getRawFrames()).toHaveLength(1);
    expect(store.getSemanticFrames()).toHaveLength(1);
    store.clear();
    expect(store.getRawFrames()).toHaveLength(0);
    expect(store.getSemanticFrames()).toHaveLength(0);
    expect(store.summary().frameCount).toBe(0);
  });

  it('enforces a bounded frame budget', () => {
    const store = createTrajectoryStore({ maxFrames: 1 });
    store.appendSemanticFrame(makeSemanticPointFrame(0, 0));
    expect(() => store.appendSemanticFrame(makeSemanticPointFrame(1, 0))).toThrow('trajectory_store_limit');
  });

  it('does not let identity-only or duplicate append paths bypass the frame budget', () => {
    const store = createTrajectoryStore({ maxFrames: 1 });
    const identity = store.identityTracker.update({
      frame: 0,
      time: 0,
      timestamp_us: 0,
      width: 1280,
      height: 720,
      candidates: [],
    });
    store.appendIdentityFrame(identity);
    expect(() => store.appendIdentityFrame({ ...identity, frame: 1, time: 1 / 30, timestamp_us: 33_333 })).toThrow('trajectory_store_limit');

    const rawStore = createTrajectoryStore({ maxFrames: 1 });
    const raw = {
      frame: 0,
      time: 0,
      timestamp_us: 0,
      width: 1280,
      height: 720,
      hands: [],
    };
    rawStore.appendRawFrame(raw);
    expect(() => rawStore.appendRawFrame(raw)).toThrow('trajectory_store_limit');
  });

  it('summarizes long sessions without spreading frame indexes into Math.max', () => {
    const store = createTrajectoryStore();
    const internal = store as unknown as { rawFrames: Array<{ frame: number }> };
    const frameCount = 130_000;
    for (let frame = 0; frame < frameCount; frame += 1) internal.rawFrames.push({ frame });

    expect(store.summary().frameCount).toBe(frameCount);
  });
});
