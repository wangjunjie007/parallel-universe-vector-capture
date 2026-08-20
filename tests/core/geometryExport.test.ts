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
    expect(bundle.quality?.valid).toBe(true);
  });
});
