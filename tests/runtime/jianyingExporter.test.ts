/* @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildJianyingExport } from '../../src/runtime/jianyingExporter';
import { makeSemanticPointFrame } from '../core/fixtures';

describe('Jianying keyframe export', () => {
  it('writes independent normalized finger tracks and conversion notes', async () => {
    const frame = makeSemanticPointFrame(3, 4);
    frame.width = 320;
    frame.height = 240;
    const result = buildJianyingExport({
      appVersion: '0.1.0',
      alignment: 'exact_source_frames',
      source: { name: 'source.webm', width: 320, height: 240, fps: 30 },
      frameCount: 10,
      frames: [frame],
    });
    const files = unzipSync(result.bytes);
    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'jianying-keyframes.csv',
      'jianying-keyframes.json',
      'jianying-manifest.json',
    ]);
    const payload = JSON.parse(strFromU8(files['jianying-keyframes.json'])) as { keyframes: Array<Record<string, unknown>>; notes: string[] };
    expect(payload.keyframes.length).toBe(4);
    expect(payload.keyframes[0]).toMatchObject({ track_id: 'hand_1:index', x_normalized: 150 / 320, y_normalized: 203 / 240, visible: true });
    expect(payload.notes.join(' ')).toContain('not an unverified native Jianying draft');
    expect(strFromU8(files['jianying-keyframes.csv'])).toContain('x_normalized');
    expect(result.fileName).toMatch(/\.zip$/);
  });

  it('keeps estimated alignment explicit instead of blocking the package', () => {
    const result = buildJianyingExport({ alignment: 'presentation_time_estimate', appVersion: '0.1.0', frames: [] });
    expect(result.bytes.length).toBeGreaterThan(0);
  });
});
