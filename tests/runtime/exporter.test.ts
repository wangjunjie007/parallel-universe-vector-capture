import { describe, expect, it } from 'vitest';
import { buildExport } from '../../src/runtime/exporter';
import { makeSemanticPointFrame } from '../core/fixtures';

describe('runtime export manifest', () => {
  it('keeps precise source metadata under the nested capture contract', async () => {
    const frame = makeSemanticPointFrame(0, 0);
    frame.width = 320;
    frame.height = 240;

    const built = buildExport(
      {
        appVersion: '0.1.0',
        modelName: 'MediaPipe Hand Landmarker',
        modelVersion: 'hand_landmarker.float16.1',
        captureMode: 'precise',
        alignment: 'exact_source_frames',
        source: {
          name: '/tmp/puvc-acceptance.webm',
          width: 320,
          height: 240,
          fps: 5,
          durationSeconds: 0.8,
          timebase: '1/1000000',
        },
        mirror: false,
        inferenceWidth: 320,
        inferenceHeight: 240,
        delegate: 'CPU',
        sourceFrameCount: 1,
        derivedFps: 5,
      },
      [frame],
      [],
    );

    expect(built.bundle.manifest.capture).toMatchObject({
      mode: 'precise',
      source_name: 'puvc-acceptance.webm',
      width: 320,
      height: 240,
    });
    expect(built.bundle.manifest).not.toHaveProperty('capture_mode');
    expect(built.bundle.manifest).not.toHaveProperty('source');
    expect(built.bundle.manifest).not.toHaveProperty('width');
    expect(built.bundle.manifest).not.toHaveProperty('height');

    // JSON round-tripping mirrors the bytes written to manifest.json and
    // confirms that optional undefined values do not become misleading nulls.
    const manifest = JSON.parse(JSON.stringify(built.bundle.manifest)) as typeof built.bundle.manifest;
    expect(manifest.capture).toMatchObject({
      mode: 'precise',
      source_name: 'puvc-acceptance.webm',
      width: 320,
      height: 240,
    });
    expect(built.standardBlob.size).toBeGreaterThan(0);
  });

  it('marks presentation-time alignment as needing review', () => {
    const built = buildExport(
      {
        appVersion: '0.1.0',
        modelName: 'MediaPipe Hand Landmarker',
        modelVersion: 'hand_landmarker.float16.1',
        captureMode: 'precise',
        alignment: 'presentation_time_estimate',
        source: { name: 'estimated.webm', width: 320, height: 240 },
        mirror: false,
        delegate: 'CPU',
        sourceFrameCount: 1,
      },
      [makeSemanticPointFrame(0, 0)],
      [],
    );

    expect(built.bundle.manifest.alignment).toBe('presentation_time_estimate');
    expect(built.bundle.quality?.needs_review).toBe(true);
    expect(built.bundle.manifest.quality.needs_review).toBe(true);
  });

  it('exports pinch compression metadata only in the extended fingertip layer', () => {
    const frame = makeSemanticPointFrame(0, 4);
    frame.extendedPoints = frame.extendedPoints.map((point) => ({
      ...point,
      compressed: point.finger === 'thumb' || point.finger === 'index',
      releaseBlend: 0,
    }));
    const built = buildExport(
      {
        appVersion: '0.1.0',
        modelName: 'MediaPipe Hand Landmarker',
        modelVersion: 'hand_landmarker.float16.1',
        captureMode: 'realtime',
        alignment: 'presentation_time_estimate',
        source: { name: 'pinch.webm', width: 1280, height: 720 },
        mirror: false,
        delegate: 'CPU',
        sourceFrameCount: 1,
      },
      [frame],
      [],
    );

    expect(built.bundle.fingertip_tracks.tracks['hand_1:thumb'][0]).toMatchObject({ compressed: true, releaseBlend: 0 });
    expect(built.bundle.semantic_tracks.frames[0].points[0]).not.toHaveProperty('compressed');
    expect(built.bundle.semantic_tracks.frames[0].points[0]).not.toHaveProperty('releaseBlend');
  });

  it('promotes invalid geometry hints to runtime package review quality', () => {
    const frame = makeSemanticPointFrame(0, 4);
    frame.points = frame.points.map((point, index) => ({ ...point, finger: index % 2 === 0 ? 'middle' : 'ring' }));
    frame.extendedPoints = frame.points;
    const built = buildExport(
      {
        appVersion: '0.1.0',
        modelName: 'MediaPipe Hand Landmarker',
        modelVersion: 'hand_landmarker.float16.1',
        captureMode: 'precise',
        alignment: 'exact_source_frames',
        source: { name: 'geometry.webm', width: 1280, height: 720 },
        mirror: false,
        delegate: 'CPU',
        sourceFrameCount: 1,
      },
      [frame],
      [],
      [],
    );

    // Runtime callers pass geometry frames explicitly; an invalid frame must
    // be reflected in both quality files even when the NDJSON is preserved.
    const invalidHint = {
      frame: 0,
      time: 0,
      state: 'pinch' as const,
      point_ids: ['hand_1:middle', 'hand_1:ring', 'hand_2:middle', 'hand_2:ring'],
      edges: [],
      faces: [],
      quality: { valid: false, warnings: ['quad_requires_expected_hand_identity'] },
    };
    const rebuilt = buildExport(
      {
        appVersion: '0.1.0',
        modelName: 'MediaPipe Hand Landmarker',
        modelVersion: 'hand_landmarker.float16.1',
        captureMode: 'precise',
        alignment: 'exact_source_frames',
        source: { name: 'geometry.webm', width: 1280, height: 720 },
        mirror: false,
        delegate: 'CPU',
        sourceFrameCount: 1,
      },
      [frame],
      [],
      [invalidHint],
    );

    expect(built.bundle.quality?.geometry_valid).toBe(true);
    expect(rebuilt.bundle.quality).toMatchObject({
      needs_review: true,
      geometry_valid: false,
      geometry_frame_count: 1,
      geometry_invalid_frames: [0],
      geometry_warning_count: 1,
      geometry_warning_frames: [0],
      geometry_warnings: ['quad_requires_expected_hand_identity'],
    });
    expect(rebuilt.bundle.manifest.quality).toMatchObject({ needs_review: true, geometry_valid: false });
    expect(rebuilt.bundle.geometry_hints_ndjson).toContain('quad_requires_expected_hand_identity');
    expect(rebuilt.bundle.diagnostics_ndjson).toContain('"type":"geometry_flags"');
  });

  it('computes source frame count for long raw tracks without argument spreading', () => {
    const frameCount = 130_000;
    const rawFrames = Array.from({ length: frameCount }, (_, frame) => ({
      frame,
      time: frame / 30,
      timestamp_us: Math.round((frame / 30) * 1_000_000),
      width: 320,
      height: 240,
      hands: [],
    }));

    const built = buildExport(
      {
        appVersion: '0.1.0',
        modelName: 'MediaPipe Hand Landmarker',
        modelVersion: 'hand_landmarker.float16.1',
        captureMode: 'precise',
        alignment: 'exact_source_frames',
        source: { name: 'long.webm', width: 320, height: 240 },
        mirror: false,
        delegate: 'CPU',
      },
      [],
      rawFrames,
    );

    expect(built.bundle.manifest.quality.source_frame_count).toBe(frameCount);
    expect(built.bundle.semantic_tracks.frame_count).toBe(frameCount);
  });
});
