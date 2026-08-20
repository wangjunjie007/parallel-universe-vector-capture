import { describe, expect, it } from 'vitest';
import {
  buildExportBundle,
  buildGeometryHint,
  buildSemanticTracks,
  buildTracksCsv,
  createManifest,
  validateSemanticFrames,
} from '../../src/core';
import { makeSemanticPointFrame } from './fixtures';

describe('geometry and export contracts', () => {
  it('uses explicit four-point topology and stable portal face id', () => {
    const hint = buildGeometryHint(makeSemanticPointFrame(12, 4));
    expect(hint.quality.valid).toBe(true);
    expect(hint.edges).toHaveLength(4);
    expect(hint.faces).toEqual([
      expect.objectContaining({ face_id: 'portal-4', topology: 'quad', stable: true }),
    ]);
    expect(hint.faces[0].point_ids).toEqual(['hand_1:thumb', 'hand_1:index', 'hand_2:index', 'hand_2:thumb']);
  });

  it('builds all 45 direct edges for the ten-point state', () => {
    const hint = buildGeometryHint(makeSemanticPointFrame(24, 10));
    expect(hint.edges).toHaveLength(45);
    expect(new Set(hint.edges.map((edge) => edge.id)).size).toBe(45);
    expect(hint.faces[0].face_id).toBe('portal-10');
  });

  it('does not invent a four-point face when expected hand identities are missing', () => {
    const frame = makeSemanticPointFrame(18, 4);
    frame.points = frame.points.map((point, index) => ({ ...point, finger: index % 2 === 0 ? 'middle' : 'ring' }));
    frame.extendedPoints = frame.points;
    const hint = buildGeometryHint(frame);
    expect(hint.faces).toHaveLength(0);
    expect(hint.quality.valid).toBe(false);
    expect(hint.quality.warnings).toContain('quad_requires_expected_hand_identity');
  });

  it('promotes geometry warnings into bundle quality while retaining every hint frame', () => {
    const valid = makeSemanticPointFrame(0, 4);
    const invalid = makeSemanticPointFrame(1, 4);
    invalid.points = invalid.points.map((point, index) => ({ ...point, finger: index % 2 === 0 ? 'middle' : 'ring' }));
    invalid.extendedPoints = invalid.points;

    const bundle = buildExportBundle([valid, invalid], {
      captureMode: 'precise',
      width: 1280,
      height: 720,
      alignment: 'exact_source_frames',
    });

    expect(bundle.geometry_hints_ndjson.split('\n').filter(Boolean)).toHaveLength(2);
    expect(bundle.quality).toMatchObject({
      valid: false,
      needs_review: true,
      geometry_valid: false,
      geometry_frame_count: 2,
      geometry_invalid_frames: [1],
      geometry_warning_count: 1,
      geometry_warning_frames: [1],
    });
    expect(bundle.quality?.geometry_warnings).toContain('quad_requires_expected_hand_identity');
    expect(bundle.manifest.quality).toMatchObject({
      valid: false,
      needs_review: true,
      geometry_valid: false,
      geometry_warning_frames: [1],
    });
    const hints = bundle.geometry_hints_ndjson.trim().split('\n').map((line) => JSON.parse(line) as { frame: number; quality: { valid: boolean } });
    expect(hints.map((hint) => hint.frame)).toEqual([0, 1]);
    expect(hints[0].quality.valid).toBe(true);
    expect(hints[1].quality.valid).toBe(false);
  });

  it('preserves strict semantic JSON shape and fixed CSV columns', () => {
    const frames = [makeSemanticPointFrame(0, 0), makeSemanticPointFrame(1, 4), makeSemanticPointFrame(2, 10)];
    const semantic = buildSemanticTracks(frames);
    expect(Object.keys(semantic)).toEqual(['frame_count', 'width', 'height', 'transitions', 'frames']);
    expect(semantic.frames.map((frame) => frame.count)).toEqual([0, 4, 10]);
    const csv = buildTracksCsv(frames);
    expect(csv.split('\n')[0]).toBe('frame,time,state,point_index,side,finger,x,y,timestamp_us,interpolated');
    expect(csv).toContain('1,0.03333333333333333,pinch');
  });

  it('sanitizes local source paths and records local-only privacy', () => {
    const manifest = createManifest({
      captureMode: 'precise',
      source: { name: '/Users/private/face video.mov', width: 1920, height: 1080, sha256: 'abc' },
      width: 1920,
      height: 1080,
      alignment: 'exact_source_frames',
    });
    expect(manifest.capture.source_name).toBe('face_video.mov');
    expect(manifest.model.version).toBe('0.10.35');
    expect(JSON.stringify(manifest)).not.toContain('/Users/private');
    expect(manifest.privacy).toEqual({ local_only: true, uploads: false, analytics: false });
  });

  it('keeps absent palm measurements as explicit JSON nulls', () => {
    const frame = makeSemanticPointFrame(0, 0);
    frame.palms = frame.palms.filter((palm) => palm.side === 'hand_1');
    const bundle = buildExportBundle([frame], {
      captureMode: 'precise',
      width: 1280,
      height: 720,
      alignment: 'exact_source_frames',
    });
    const missing = bundle.palm_tracks.tracks.hand_2[0];
    expect(missing).toMatchObject({ x: null, y: null, scale: null, orientation: null, visible: false });
    expect(JSON.parse(JSON.stringify(missing)).x).toBeNull();
  });

  it('flags semantic count and uniqueness violations', () => {
    const invalid = makeSemanticPointFrame(0, 4);
    invalid.points = invalid.points.slice(0, 3);
    const result = validateSemanticFrames([invalid]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.startsWith('count_mismatch'))).toBe(true);
  });

  it('builds a complete compatibility bundle', () => {
    const frames = [makeSemanticPointFrame(0, 0), makeSemanticPointFrame(1, 4), makeSemanticPointFrame(2, 10)];
    const bundle = buildExportBundle(frames, { captureMode: 'precise', width: 1280, height: 720, alignment: 'exact_source_frames' });
    expect(bundle.manifest.schema).toBe('parallel-universe-vector-capture/1');
    expect(bundle.semantic_tracks.frame_count).toBe(3);
    expect(bundle.fingertip_tracks.coordinate_space).toBe('source_pixels_top_left');
    expect(bundle.geometry_hints_ndjson.split('\n').filter(Boolean)).toHaveLength(3);
    expect(bundle.quality).toMatchObject({ valid: true, needs_review: false, geometry_valid: true, geometry_frame_count: 3, geometry_invalid_frames: [], geometry_warning_count: 0, geometry_warning_frames: [], geometry_warnings: [] });
    expect(bundle.manifest.quality).toMatchObject({ valid: true, needs_review: false, geometry_valid: true });
  });
});
