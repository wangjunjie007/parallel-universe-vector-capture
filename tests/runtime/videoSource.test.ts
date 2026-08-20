import { afterEach, describe, expect, it, vi } from 'vitest';
import { advancePresentedFrame, inspectVideoFile, processVideoFile } from '../../src/runtime/videoSource';

describe('advancePresentedFrame', () => {
  it('records frames missed before the first RVFC callback', () => {
    const result = advancePresentedFrame(undefined, 3, 1);

    expect(result.current).toEqual({ frame: 2, presentedFrames: 3, mediaTime: 1 });
    expect(result.gaps.map(({ frame }) => frame)).toEqual([0, 1]);
    expect(result.gaps.map(({ timestampUs }) => timestampUs)).toEqual([333333, 666667]);
  });

  it('preserves monotonic frame numbers and interpolated gap timestamps', () => {
    const previous = { frame: 2, presentedFrames: 3, mediaTime: 1 };
    const result = advancePresentedFrame(previous, 6, 2);

    expect(result.current.frame).toBe(5);
    expect(result.gaps.map(({ frame }) => frame)).toEqual([3, 4]);
    expect(result.gaps[0]?.mediaTime).toBeCloseTo(4 / 3);
    expect(result.gaps[1]?.mediaTime).toBeCloseTo(5 / 3);
    expect(result.gaps.every(({ timestampUs }) => Number.isInteger(timestampUs))).toBe(true);
  });

  it('rejects non-monotonic presented counters and media times', () => {
    const previous = { frame: 2, presentedFrames: 3, mediaTime: 1 };
    expect(() => advancePresentedFrame(previous, 3, 1.1)).toThrow('presented_frame_counter_not_increasing');
    expect(() => advancePresentedFrame(previous, 4, 0.9)).toThrow('media_time_not_monotonic');
  });
});

describe('processVideoFile fallback', () => {
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(document, 'createElement', { configurable: true, value: originalCreateElement });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL });
  });

  it('marks seek-based processing as a presentation-time estimate', async () => {
    const video = originalCreateElement('video');
    let currentTime = 0;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.1 },
      videoWidth: { configurable: true, value: 640 },
      videoHeight: { configurable: true, value: 360 },
      readyState: { configurable: true, value: 4 },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
          queueMicrotask(() => video.dispatchEvent(new Event('seeked')));
        },
      },
    });
    Object.defineProperties(video, {
      load: { configurable: true, value: () => video.dispatchEvent(new Event('loadedmetadata')) },
      pause: { configurable: true, value: vi.fn() },
      removeAttribute: { configurable: true, value: vi.fn() },
    });
    Object.defineProperty(video, 'requestVideoFrameCallback', { configurable: true, value: undefined });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-video') });

    const frames: number[] = [];
    const result = await processVideoFile({
      name: 'fixture.webm',
      width: 640,
      height: 360,
      duration: 0.1,
      fps: 10,
      mimeType: 'video/webm',
      url: 'blob:test-video',
    }, {
      onFrame: ({ frame }) => { frames.push(frame); },
    });

    expect(frames).toEqual([0]);
    expect(result).toMatchObject({
      processedFrames: 1,
      sourceFrameCount: 1,
      decodeGaps: 0,
      derivedFps: 10,
      alignment: 'presentation_time_estimate',
      method: 'seek-estimate',
    });
  });

  it('cleans the temporary element after a metadata decode failure without revoking the caller URL', async () => {
    const video = originalCreateElement('video');
    let loadCount = 0;
    const load = vi.fn(() => {
      loadCount += 1;
      if (loadCount === 1) video.dispatchEvent(new Event('error'));
    });
    const pause = vi.fn();
    const removeAttribute = vi.fn();
    Object.defineProperties(video, {
      load: { configurable: true, value: load },
      pause: { configurable: true, value: pause },
      removeAttribute: { configurable: true, value: removeAttribute },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    await expect(processVideoFile({
      name: 'broken.webm',
      width: 640,
      height: 360,
      duration: 1,
      mimeType: 'video/webm',
      url: 'blob:caller-owned',
    }, { onFrame: vi.fn() })).rejects.toThrow('Video could not be decoded');

    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('cleans the temporary element and preserves a synchronous load error', async () => {
    const video = originalCreateElement('video');
    let loadCount = 0;
    const load = vi.fn(() => {
      loadCount += 1;
      if (loadCount === 1) throw new Error('load exploded');
    });
    const pause = vi.fn();
    const removeAttribute = vi.fn();
    Object.defineProperties(video, {
      load: { configurable: true, value: load },
      pause: { configurable: true, value: pause },
      removeAttribute: { configurable: true, value: removeAttribute },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);

    await expect(processVideoFile({
      name: 'throwing.webm',
      width: 640,
      height: 360,
      duration: 1,
      mimeType: 'video/webm',
      url: 'blob:throwing',
    }, { onFrame: vi.fn() })).rejects.toThrow('load exploded');

    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('cleans the temporary element when processing was already cancelled', async () => {
    const video = originalCreateElement('video');
    const load = vi.fn();
    const pause = vi.fn();
    const removeAttribute = vi.fn();
    Object.defineProperties(video, {
      load: { configurable: true, value: load },
      pause: { configurable: true, value: pause },
      removeAttribute: { configurable: true, value: removeAttribute },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    const abort = new AbortController();
    abort.abort();

    await expect(processVideoFile({
      name: 'cancelled.webm',
      width: 640,
      height: 360,
      duration: 1,
      mimeType: 'video/webm',
      url: 'blob:cancelled',
    }, { signal: abort.signal, onFrame: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });

    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('revokes an inspection URL when loading throws before metadata is available', async () => {
    const video = originalCreateElement('video');
    let loadCount = 0;
    const load = vi.fn(() => {
      loadCount += 1;
      if (loadCount === 1) throw new Error('metadata load exploded');
    });
    const removeAttribute = vi.fn();
    Object.defineProperties(video, {
      load: { configurable: true, value: load },
      pause: { configurable: true, value: vi.fn() },
      removeAttribute: { configurable: true, value: removeAttribute },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:inspection') });
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    await expect(inspectVideoFile(new File(['video'], 'broken.webm', { type: 'video/webm' }))).rejects.toThrow('metadata load exploded');

    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:inspection');
  });
});

describe('processVideoFile RVFC pacing', () => {
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalImageBitmap = globalThis.ImageBitmap;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(document, 'createElement', { configurable: true, value: originalCreateElement });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: originalCreateImageBitmap });
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, value: originalImageBitmap });
  });

  it('pauses each presented frame until its consumer finishes', async () => {
    const video = originalCreateElement('video');
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    const events: string[] = [];
    const frameTimes = [0, 0.1, 0.2];
    let callbackId = 0;
    let presentedFrames = 0;
    let paused = true;
    let ended = false;

    const dispatchNext = () => {
      queueMicrotask(() => {
        if (paused || ended) return;
        const entry = callbacks.entries().next().value as [number, VideoFrameRequestCallback] | undefined;
        if (!entry) return;
        callbacks.delete(entry[0]);
        if (presentedFrames >= frameTimes.length) {
          ended = true;
          video.dispatchEvent(new Event('ended'));
          return;
        }
        presentedFrames += 1;
        events.push(`present:${presentedFrames}`);
        entry[1](performance.now(), {
          mediaTime: frameTimes[presentedFrames - 1],
          presentedFrames,
          expectedDisplayTime: performance.now(),
          presentationTime: performance.now(),
          width: 640,
          height: 360,
        });
      });
    };

    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.3 },
      videoWidth: { configurable: true, value: 640 },
      videoHeight: { configurable: true, value: 360 },
      readyState: { configurable: true, value: 4 },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => ended },
      load: { configurable: true, value: () => video.dispatchEvent(new Event('loadedmetadata')) },
      play: {
        configurable: true,
        value: vi.fn(async () => {
          paused = false;
          events.push('play');
          dispatchNext();
        }),
      },
      pause: {
        configurable: true,
        value: vi.fn(() => {
          paused = true;
          events.push('pause');
        }),
      },
      removeAttribute: { configurable: true, value: vi.fn() },
      requestVideoFrameCallback: {
        configurable: true,
        value: (callback: VideoFrameRequestCallback) => {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
      },
      cancelVideoFrameCallback: { configurable: true, value: (id: number) => callbacks.delete(id) },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap),
    });

    const consumed: number[] = [];
    const result = await processVideoFile({
      name: 'paced.webm',
      width: 640,
      height: 360,
      duration: 0.3,
      fps: 10,
      mimeType: 'video/webm',
      url: 'blob:paced-video',
    }, {
      onFrame: async ({ frame }) => {
        expect(paused).toBe(true);
        events.push(`consume:${frame}`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1));
        consumed.push(frame);
      },
    });

    expect(consumed).toEqual([0, 1, 2]);
    expect(result).toMatchObject({
      processedFrames: 3,
      sourceFrameCount: 3,
      decodeGaps: 0,
      derivedFps: 10,
      alignment: 'exact_source_frames',
      method: 'rvfc-paced',
    });
    expect(events).toEqual([
      'consume:0',
      'play', 'present:1', 'pause',
      'play', 'present:2', 'pause', 'consume:1',
      'play', 'present:3', 'pause', 'consume:2',
      'play', 'pause',
    ]);
  });

  it('keeps the decoded time-zero frame when Chromium starts RVFC at counter two', async () => {
    const video = originalCreateElement('video');
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    const frameTimes = [0, 0.1, 0.2];
    let callbackId = 0;
    let presentedFrames = 1;
    let paused = true;
    let ended = false;

    const dispatchNext = () => {
      queueMicrotask(() => {
        if (paused || ended) return;
        const entry = callbacks.entries().next().value as [number, VideoFrameRequestCallback] | undefined;
        if (!entry) return;
        callbacks.delete(entry[0]);
        if (presentedFrames >= frameTimes.length) {
          ended = true;
          video.dispatchEvent(new Event('ended'));
          return;
        }
        presentedFrames += 1;
        entry[1](performance.now(), {
          mediaTime: frameTimes[presentedFrames - 1],
          presentedFrames,
          expectedDisplayTime: performance.now(),
          presentationTime: performance.now(),
          width: 640,
          height: 360,
        });
      });
    };

    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.3 },
      videoWidth: { configurable: true, value: 640 },
      videoHeight: { configurable: true, value: 360 },
      readyState: { configurable: true, value: 4 },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => ended },
      load: { configurable: true, value: () => video.dispatchEvent(new Event('loadedmetadata')) },
      play: {
        configurable: true,
        value: vi.fn(async () => {
          paused = false;
          dispatchNext();
        }),
      },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      removeAttribute: { configurable: true, value: vi.fn() },
      requestVideoFrameCallback: {
        configurable: true,
        value: (callback: VideoFrameRequestCallback) => {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
      },
      cancelVideoFrameCallback: { configurable: true, value: (id: number) => callbacks.delete(id) },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap),
    });

    const consumed: number[] = [];
    const result = await processVideoFile({
      name: 'chromium-start.webm',
      width: 640,
      height: 360,
      duration: 0.3,
      fps: 10,
      mimeType: 'video/webm',
      url: 'blob:chromium-start',
    }, {
      onFrame: ({ frame }) => { consumed.push(frame); },
    });

    expect(consumed).toEqual([0, 1, 2]);
    expect(result).toMatchObject({
      processedFrames: 3,
      sourceFrameCount: 3,
      decodeGaps: 0,
      derivedFps: 10,
      alignment: 'exact_source_frames',
      method: 'rvfc-paced',
    });
  });

  it('copies a paused single-frame video through canvas when direct bitmap creation rejects', async () => {
    const video = originalCreateElement('video');
    const canvas = originalCreateElement('canvas');
    const context = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(canvas, 'getContext', { configurable: true, value: vi.fn(() => context) });
    let ended = false;
    let paused = true;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.033333 },
      videoWidth: { configurable: true, value: 96 },
      videoHeight: { configurable: true, value: 64 },
      readyState: { configurable: true, value: 4 },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => ended },
      load: { configurable: true, value: () => video.dispatchEvent(new Event('loadedmetadata')) },
      play: {
        configurable: true,
        value: vi.fn(async () => {
          paused = false;
          queueMicrotask(() => {
            ended = true;
            video.dispatchEvent(new Event('ended'));
          });
        }),
      },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      removeAttribute: { configurable: true, value: vi.fn() },
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn(() => 1),
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(document, 'createElement').mockReturnValueOnce(video).mockReturnValueOnce(canvas);
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async (source: unknown) => {
        if (source === video) throw new Error('video source rejected');
        return bitmap;
      }),
    });

    const frames: number[] = [];
    const result = await processVideoFile({
      name: 'tiny.mp4',
      width: 96,
      height: 64,
      duration: 0.033333,
      fps: 30,
      mimeType: 'video/mp4',
      url: 'blob:tiny-video',
    }, {
      onFrame: ({ frame }) => { frames.push(frame); },
    });

    expect(frames).toEqual([0]);
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 96, 64);
    expect(result).toMatchObject({
      processedFrames: 1,
      sourceFrameCount: 1,
      decodeGaps: 0,
      alignment: 'exact_source_frames',
      method: 'rvfc-paced',
    });
  });

  it('finishes when playback ends without another RVFC callback', async () => {
    const video = originalCreateElement('video');
    let ended = false;
    let paused = true;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.033333 },
      videoWidth: { configurable: true, value: 96 },
      videoHeight: { configurable: true, value: 64 },
      readyState: { configurable: true, value: 4 },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => ended },
      load: { configurable: true, value: () => video.dispatchEvent(new Event('loadedmetadata')) },
      play: {
        configurable: true,
        value: vi.fn(async () => {
          paused = false;
          ended = true;
        }),
      },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      removeAttribute: { configurable: true, value: vi.fn() },
      requestVideoFrameCallback: { configurable: true, value: vi.fn(() => 1) },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => bitmap),
    });

    const frames: number[] = [];
    const result = await processVideoFile({
      name: 'ended-without-rvfc.webm',
      width: 96,
      height: 64,
      duration: 0.033333,
      fps: 30,
      mimeType: 'video/webm',
      url: 'blob:ended-without-rvfc',
    }, {
      onFrame: ({ frame }) => { frames.push(frame); },
    });

    expect(frames).toEqual([0]);
    expect(result).toMatchObject({
      processedFrames: 1,
      sourceFrameCount: 1,
      decodeGaps: 0,
      alignment: 'exact_source_frames',
      method: 'rvfc-paced',
    });
  });

  it('does not wait for a playback promise that never settles', async () => {
    const video = originalCreateElement('video');
    let ended = false;
    let paused = true;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.033333 },
      videoWidth: { configurable: true, value: 96 },
      videoHeight: { configurable: true, value: 64 },
      readyState: { configurable: true, value: 4 },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => ended },
      load: { configurable: true, value: () => video.dispatchEvent(new Event('loadedmetadata')) },
      play: {
        configurable: true,
        value: vi.fn(() => {
          paused = false;
          ended = true;
          return new Promise<void>(() => undefined);
        }),
      },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      removeAttribute: { configurable: true, value: vi.fn() },
      requestVideoFrameCallback: { configurable: true, value: vi.fn(() => 1) },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => bitmap),
    });

    const result = await processVideoFile({
      name: 'pending-play.webm',
      width: 96,
      height: 64,
      duration: 0.033333,
      fps: 30,
      mimeType: 'video/webm',
      url: 'blob:pending-play',
    }, { onFrame: vi.fn() });

    expect(video.play).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      processedFrames: 1,
      sourceFrameCount: 1,
      decodeGaps: 0,
      alignment: 'exact_source_frames',
      method: 'rvfc-paced',
    });
  });

  it('stops scheduling after abort and eventually releases an in-flight snapshot', async () => {
    class OwnedBitmap {
      close = vi.fn();
    }
    const video = originalCreateElement('video');
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let callbackId = 0;
    let paused = true;
    const requestFrame = vi.fn((callback: VideoFrameRequestCallback) => {
      const id = ++callbackId;
      callbacks.set(id, callback);
      return id;
    });
    const play = vi.fn(async () => {
      paused = false;
      queueMicrotask(() => {
        const entry = callbacks.entries().next().value as [number, VideoFrameRequestCallback] | undefined;
        if (!entry) return;
        callbacks.delete(entry[0]);
        entry[1](performance.now(), {
          mediaTime: 0.1,
          presentedFrames: 2,
          expectedDisplayTime: performance.now(),
          presentationTime: performance.now(),
          width: 640,
          height: 360,
        });
      });
    });
    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.3 },
      videoWidth: { configurable: true, value: 640 },
      videoHeight: { configurable: true, value: 360 },
      readyState: { configurable: true, value: 4 },
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, value: false },
      load: { configurable: true, value: () => video.dispatchEvent(new Event('loadedmetadata')) },
      play: { configurable: true, value: play },
      pause: { configurable: true, value: vi.fn(() => { paused = true; }) },
      removeAttribute: { configurable: true, value: vi.fn() },
      requestVideoFrameCallback: { configurable: true, value: requestFrame },
      cancelVideoFrameCallback: { configurable: true, value: (id: number) => callbacks.delete(id) },
    });
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    const firstBitmap = new OwnedBitmap();
    const inFlightBitmap = new OwnedBitmap();
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, value: OwnedBitmap });
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn()
        .mockResolvedValueOnce(firstBitmap)
        .mockResolvedValueOnce(inFlightBitmap),
    });

    let releaseFrame: (() => void) | undefined;
    const frameBlocked = new Promise<void>((resolve) => { releaseFrame = resolve; });
    const onFrame = vi.fn(async ({ frame }: { frame: number }) => {
      if (frame === 1) await frameBlocked;
    });
    const onProgress = vi.fn();
    const abort = new AbortController();
    const processing = processVideoFile({
      name: 'abort-in-flight.webm',
      width: 640,
      height: 360,
      duration: 0.3,
      fps: 10,
      mimeType: 'video/webm',
      url: 'blob:abort-in-flight',
    }, { signal: abort.signal, onFrame, onProgress });

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(2));
    expect(firstBitmap.close).toHaveBeenCalledTimes(1);
    abort.abort();
    await expect(processing).rejects.toMatchObject({ name: 'AbortError' });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(inFlightBitmap.close).not.toHaveBeenCalled();

    releaseFrame?.();
    await vi.waitFor(() => expect(inFlightBitmap.close).toHaveBeenCalledTimes(1));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });
});
