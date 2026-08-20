import { sha256Blob } from './assetIntegrity';

export interface LocalVideoMetadata {
  name: string;
  width: number;
  height: number;
  duration: number;
  fps?: number;
  mimeType: string;
  url: string;
  file?: File;
  /** Optional content hash; computed locally without uploading the source. */
  sha256?: string;
}

export interface PreciseFrame {
  frame: number;
  mediaTime: number;
  timestampUs: number;
  presentedFrames?: number;
  /**
   * RVFC supplies a stable snapshot. The HTMLVideoElement variant is limited
   * to the explicitly estimated seek fallback while the element is paused.
   */
  image: HTMLVideoElement | ImageBitmap | VideoFrame;
}

export interface DecodeGapFrame {
  frame: number;
  mediaTime: number;
  timestampUs: number;
  reason: 'presented_frame_gap';
}

export interface ProcessProgress {
  frame: number;
  time: number;
  processedFrames: number;
  sourceFrames: number;
  estimatedTotalFrames?: number;
}

export interface ProcessVideoOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProcessProgress) => void;
  onDecodeGap?: (frame: DecodeGapFrame) => Promise<void> | void;
  onFrame: (frame: PreciseFrame) => Promise<void> | void;
}

export interface ProcessVideoResult {
  processedFrames: number;
  sourceFrameCount: number;
  decodeGaps: number;
  derivedFps?: number;
  alignment: 'exact_source_frames' | 'presentation_time_estimate';
  method: 'rvfc-paced' | 'seek-estimate';
}

export interface PresentedFrameClock {
  frame: number;
  presentedFrames: number;
  mediaTime: number;
}

export interface PresentedFrameAdvance {
  current: PresentedFrameClock;
  gaps: DecodeGapFrame[];
}

const abortError = () => new DOMException('Processing cancelled', 'AbortError');

function mediaError(video: HTMLVideoElement, fallback: string): Error {
  const code = video.error?.code;
  return new Error(`${fallback}${code ? ` (media error ${code})` : ''}`);
}

function waitForMediaEvent(target: HTMLVideoElement, event: 'loadedmetadata' | 'loadeddata' | 'seeked', signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onEvent = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(mediaError(target, 'Video could not be decoded')); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => {
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseVideoElement(video: HTMLVideoElement): void {
  try { video.pause(); } catch { /* best-effort decoder cleanup */ }
  try { video.srcObject = null; } catch { /* srcObject may be read-only in older browsers */ }
  try { video.removeAttribute('src'); } catch { /* detached element */ }
  try { video.load(); } catch { /* cleanup must not mask the processing error */ }
}

function median(values: number[]): number | undefined {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!finite.length) return undefined;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

/** Advance frame identity without assuming a 30 fps time base. */
export function advancePresentedFrame(previous: PresentedFrameClock | undefined, presentedFrames: number, mediaTime: number): PresentedFrameAdvance {
  if (!Number.isFinite(presentedFrames) || presentedFrames < 0) throw new Error('invalid_presented_frame_counter');
  if (!Number.isFinite(mediaTime) || mediaTime < 0) throw new Error('invalid_media_time');
  const counter = Math.max(0, Math.round(presentedFrames));
  if (!previous) {
    // RVFC counters are normally one-based.  A value greater than one on the
    // first callback means playback began before our callback was installed;
    // retain that fact as explicit gap frames instead of silently relabelling
    // the first observed frame as source frame zero.
    const currentFrame = Math.max(0, counter - 1);
    const gaps: DecodeGapFrame[] = [];
    if (counter > 1) {
      for (let frame = 0; frame < currentFrame; frame += 1) {
        const factor = (frame + 1) / counter;
        const gapTime = mediaTime * factor;
        gaps.push({
          frame,
          mediaTime: gapTime,
          timestampUs: Math.round(gapTime * 1_000_000),
          reason: 'presented_frame_gap',
        });
      }
    }
    return { current: { frame: currentFrame, presentedFrames: counter, mediaTime }, gaps };
  }
  const delta = counter - previous.presentedFrames;
  if (delta <= 0) throw new Error('presented_frame_counter_not_increasing');
  if (mediaTime + 1e-6 < previous.mediaTime) throw new Error('media_time_not_monotonic');
  const currentFrame = previous.frame + delta;
  const gaps: DecodeGapFrame[] = [];
  for (let offset = 1; offset < delta; offset += 1) {
    const factor = offset / delta;
    const gapTime = previous.mediaTime + (mediaTime - previous.mediaTime) * factor;
    gaps.push({
      frame: previous.frame + offset,
      mediaTime: gapTime,
      timestampUs: Math.round(gapTime * 1_000_000),
      reason: 'presented_frame_gap',
    });
  }
  return { current: { frame: currentFrame, presentedFrames: counter, mediaTime }, gaps };
}

export async function inspectVideoFile(file: File): Promise<LocalVideoMetadata> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  let retainUrl = false;
  try {
    let duration = 0;
    let width = 0;
    let height = 0;
    const inspection = new AbortController();
    try {
      const ready = waitForMediaEvent(video, 'loadedmetadata', inspection.signal);
      // If setting/loading the source throws synchronously, the finally block
      // aborts this waiter. Attach a handler now so that cleanup cannot create
      // an unhandled rejection before the original load error is propagated.
      void ready.catch(() => undefined);
      video.src = url;
      video.load();
      await ready;
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Video has no readable duration');
      if (!video.videoWidth || !video.videoHeight) throw new Error('Video has no readable dimensions');
      duration = video.duration;
      width = video.videoWidth;
      height = video.videoHeight;
    } finally {
      inspection.abort();
      releaseVideoElement(video);
    }
    let sha256: string | undefined;
    try {
      // A full-file digest is useful for reproducibility, but avoid a second
      // very large allocation on constrained devices.  The source remains
      // local either way; the manifest simply omits the optional hash when it
      // cannot be computed safely.
      if (file.size <= 512 * 1024 * 1024) sha256 = await sha256Blob(file);
    } catch {
      sha256 = undefined;
    }
    const metadata = {
      name: file.name,
      width,
      height,
      duration,
      mimeType: file.type || 'video/*',
      url,
      file,
      sha256,
    };
    retainUrl = true;
    return metadata;
  } finally {
    // A successful inspection transfers URL ownership to LocalVideoMetadata;
    // every failure path retains ownership here and must revoke it.
    if (!retainUrl) URL.revokeObjectURL(url);
  }
}

export function preferredRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export interface RecordingController {
  stop: () => Promise<Blob>;
  mimeType: string;
}

export function startRecording(stream: MediaStream): RecordingController {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable');
  const mimeType = preferredRecordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.start(250);
  return {
    mimeType: recorder.mimeType || mimeType || 'video/webm',
    stop: () => new Promise((resolve, reject) => {
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' })), { once: true });
      recorder.addEventListener('error', () => reject(new Error('Recording failed')), { once: true });
      recorder.stop();
    }),
  };
}

type PreciseImage = PreciseFrame['image'];

export function canSnapshotPresentedFrame(): boolean {
  // The worker client already owns ImageBitmap transfer and release.  A
  // VideoFrame-only browser would need an additional transfer/close contract;
  // use the explicit seek-estimate path there rather than leak frames or claim
  // a precise result from a moving HTMLVideoElement.
  return typeof createImageBitmap === 'function';
}

/** Snapshot the element while the RVFC callback still refers to the frame. */
async function snapshotPresentedFrame(video: HTMLVideoElement): Promise<PreciseImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(video);
    } catch {
      // Some Chromium builds reject a paused, single-frame video source even
      // though the frame is decoded. Copy that current decoded frame through
      // a canvas before giving up; unlike the seek fallback, this still uses
      // the frame represented by the RVFC callback and remains source-exact.
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) throw new Error('Presented frame snapshot is unavailable');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Presented frame snapshot is unavailable');
      try {
        context.drawImage(video, 0, 0, width, height);
        return await createImageBitmap(canvas);
      } catch {
        // Preserve a truthful failure when the decoded frame cannot be copied.
      }
    }
  }
  throw new Error('Presented frame snapshot is unavailable');
}

function releasePreciseImage(image: PreciseImage): void {
  const isBitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
  const isVideoFrame = typeof VideoFrame !== 'undefined' && image instanceof VideoFrame;
  if (isBitmap || isVideoFrame) {
    try { image.close(); } catch { /* already transferred or closed */ }
  }
}

function playAfterTask(
  video: HTMLVideoElement,
  signal: AbortSignal | undefined,
  onError: (error: unknown) => void,
  onStarted?: () => void,
): void {
  if (signal?.aborted || video.ended || !video.paused) return;
  // Chromium can ignore a play() issued in the same task in which an RVFC
  // callback called pause().  Crossing a task boundary makes the state change
  // observable and avoids the one-frame stall seen in precise imports.
  window.setTimeout(() => {
    if (signal?.aborted || video.ended || !video.paused) return;
    try {
      const playback = video.play();
      // Do not await this promise. Some browsers leave it pending while the
      // media element is already advancing; RVFC and `ended` are the actual
      // completion signals for precise processing.
      void Promise.resolve(playback).catch(onError);
      onStarted?.();
    } catch (error) {
      onError(error);
    }
  }, 0);
}

async function processWithRvfc(video: HTMLVideoElement, metadata: LocalVideoMetadata, options: ProcessVideoOptions): Promise<ProcessVideoResult> {
  if (!canSnapshotPresentedFrame()) {
    // Without a frame snapshot primitive, a moving HTMLVideoElement cannot be
    // handed to an asynchronous consumer safely.  The caller selects the
    // explicit seek-estimate path instead of producing an untruthful result.
    throw new Error('Presented frame snapshot is unavailable');
  }

  let callbackHandle: number | undefined;
  let producerDone = false;
  let presentedClock: PresentedFrameClock | undefined;
  let processedClock: PresentedFrameClock | undefined;
  let initialFrameProcessed = false;
  let processedFrames = 0;
  let decodeGaps = 0;
  const frameRates: number[] = [];
  let mediaEnded = false;
  let failure: unknown;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });

  const fail = (error: unknown) => {
    if (producerDone) return;
    producerDone = true;
    failure = error;
    if (callbackHandle !== undefined) video.cancelVideoFrameCallback?.(callbackHandle);
    callbackHandle = undefined;
    resolveCompletion?.();
  };
  const onAbort = () => fail(abortError());
  const onError = () => fail(mediaError(video, 'Video decoding failed during frame processing'));
  const onEnded = () => {
    mediaEnded = true;
    if (!processingFrame) {
      if (!processedFrames) fail(new Error('Video contains no decodable frames'));
      else finish();
    }
  };
  const finish = () => {
    if (producerDone) return;
    producerDone = true;
    callbackHandle = undefined;
    resolveCompletion?.();
  };
  let processingFrame = false;
  const scheduleNext = () => {
    if (producerDone || options.signal?.aborted) return;
    try {
      callbackHandle = video.requestVideoFrameCallback!(onPresented);
    } catch (error) {
      fail(error);
    }
  };

  const processPresented = async (info: VideoFrameCallbackMetadata): Promise<void> => {
    // A browser may present the already-decoded time-zero frame while the
    // element is first started, then deliver the first RVFC callback for the
    // next frame (Chromium reports presentedFrames=2 in that case).  The
    // explicit initial snapshot below owns frame zero; ignore only the
    // duplicate callback that still describes that same time-zero frame.
    if (initialFrameProcessed && info.mediaTime <= 1e-6 && info.presentedFrames === 1) {
      scheduleNext();
      playAfterTask(video, options.signal, fail, () => {
        if (!producerDone && (video.ended || video.currentTime >= Math.max(0, metadata.duration - 1e-6))) finish();
      });
      return;
    }
    let advance: PresentedFrameAdvance;
    try {
      advance = advancePresentedFrame(presentedClock, info.presentedFrames, info.mediaTime);
    } catch (error) {
      fail(error);
      return;
    }
    presentedClock = advance.current;

    let image: PreciseImage;
    try {
      image = await snapshotPresentedFrame(video);
    } catch (error) {
      fail(error);
      return;
    }
    try {
      if (processedClock && advance.current.mediaTime > processedClock.mediaTime) {
        const elapsed = advance.current.mediaTime - processedClock.mediaTime;
        const frameDelta = advance.current.frame - processedClock.frame;
        if (elapsed > 0) frameRates.push(frameDelta / elapsed);
      }
      for (const gap of advance.gaps) {
        if (producerDone || options.signal?.aborted) return;
        decodeGaps += 1;
        await options.onDecodeGap?.(gap);
      }
      if (producerDone || options.signal?.aborted) return;
      await options.onFrame({
        frame: advance.current.frame,
        mediaTime: advance.current.mediaTime,
        timestampUs: Math.round(advance.current.mediaTime * 1_000_000),
        presentedFrames: advance.current.presentedFrames,
        image,
      });
      if (producerDone || options.signal?.aborted) return;
      processedClock = advance.current;
      processedFrames += 1;
      const derivedFps = median(frameRates);
      options.onProgress?.({
        frame: advance.current.frame,
        time: advance.current.mediaTime,
        processedFrames,
        sourceFrames: advance.current.frame + 1,
        estimatedTotalFrames: derivedFps ? Math.max(advance.current.frame + 1, Math.round(metadata.duration * derivedFps)) : undefined,
      });
      if (mediaEnded || info.mediaTime >= Math.max(0, metadata.duration - 1e-6)) {
        finish();
        return;
      }
      // Register only after this frame has been fully consumed.  The video is
      // paused while inference runs, so no presented frame can be skipped.
      scheduleNext();
      playAfterTask(video, options.signal, fail);
    } catch (error) {
      fail(error);
    } finally {
      releasePreciseImage(image);
    }
  };

  const onPresented = (_now: number, info: VideoFrameCallbackMetadata) => {
    callbackHandle = undefined;
    if (producerDone || options.signal?.aborted) return;
    try {
      // Pause synchronously before any asynchronous snapshot or inference.
      // This is the backpressure boundary for precise source-frame mode.
      video.pause();
    } catch (error) {
      fail(error);
      return;
    }
    processingFrame = true;
    void processPresented(info).finally(() => { processingFrame = false; });
  };

  const processInitialFrame = async (): Promise<void> => {
    let image: PreciseImage;
    try {
      image = await snapshotPresentedFrame(video);
    } catch (error) {
      fail(error);
      return;
    }
    try {
      if (producerDone || options.signal?.aborted) return;
      await options.onFrame({
        frame: 0,
        mediaTime: 0,
        timestampUs: 0,
        presentedFrames: 1,
        image,
      });
      if (producerDone || options.signal?.aborted) return;
      initialFrameProcessed = true;
      presentedClock = { frame: 0, presentedFrames: 1, mediaTime: 0 };
      processedClock = presentedClock;
      processedFrames = 1;
      options.onProgress?.({
        frame: 0,
        time: 0,
        processedFrames,
        sourceFrames: 1,
        estimatedTotalFrames: metadata.fps && metadata.fps > 0
          ? Math.max(1, Math.round(metadata.duration * metadata.fps))
          : undefined,
      });
      if (metadata.duration <= 1e-6) finish();
    } catch (error) {
      fail(error);
    } finally {
      releasePreciseImage(image);
    }
  };

  video.addEventListener('ended', onEnded, { once: true });
  video.addEventListener('error', onError, { once: true });
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // HAVE_CURRENT_DATA guarantees that the paused element exposes the
    // decoded time-zero image.  Processing it before playback prevents the
    // browser's initial compositor presentation from becoming a false gap.
    await processInitialFrame();
    if (!producerDone) {
      scheduleNext();
      // Starting playback is deliberately fire-and-forget. Awaiting the
      // browser's play() promise can stall forever on a decoded source whose
      // autoplay decision is still pending, even though RVFC callbacks work.
      playAfterTask(video, options.signal, fail, () => {
        if (!producerDone && (video.ended || video.currentTime >= Math.max(0, metadata.duration - 1e-6))) finish();
      });
      // A source with only one decodable frame can finish synchronously while
      // `play()` is settling. In that case Chromium may not deliver another
      // RVFC callback (the time-zero frame was already consumed), so the
      // `ended` event is the only completion signal. Check the element state
      // explicitly after playback starts to avoid leaving the caller waiting.
      if (!producerDone && (video.ended || video.currentTime >= Math.max(0, metadata.duration - 1e-6))) {
        finish();
      }
    }
    await completion;
  } finally {
    producerDone = true;
    if (callbackHandle !== undefined) video.cancelVideoFrameCallback?.(callbackHandle);
    callbackHandle = undefined;
    video.removeEventListener('ended', onEnded);
    video.removeEventListener('error', onError);
    options.signal?.removeEventListener('abort', onAbort);
  }
  if (failure) throw failure;
  if (!processedClock || processedFrames === 0) throw new Error('Video contains no decodable frames');
  return {
    processedFrames,
    sourceFrameCount: processedClock.frame + 1,
    decodeGaps,
    derivedFps: median(frameRates),
    alignment: decodeGaps === 0 ? 'exact_source_frames' : 'presentation_time_estimate',
    method: 'rvfc-paced',
  };
}

async function processWithSeekFallback(video: HTMLVideoElement, metadata: LocalVideoMetadata, options: ProcessVideoOptions): Promise<ProcessVideoResult> {
  const fps = metadata.fps && metadata.fps > 0 ? metadata.fps : 30;
  const totalFrames = Math.max(1, Math.ceil(metadata.duration * fps));
  for (let frame = 0; frame < totalFrames; frame += 1) {
    if (options.signal?.aborted) throw abortError();
    const mediaTime = Math.min(Math.max(0, metadata.duration - Number.EPSILON), frame / fps);
    if (Math.abs(video.currentTime - mediaTime) > 1e-6) {
      const seeked = waitForMediaEvent(video, 'seeked', options.signal);
      video.currentTime = mediaTime;
      await seeked;
    }
    await options.onFrame({ frame, mediaTime, timestampUs: Math.round(mediaTime * 1_000_000), image: video });
    options.onProgress?.({ frame, time: mediaTime, processedFrames: frame + 1, sourceFrames: frame + 1, estimatedTotalFrames: totalFrames });
  }
  return {
    processedFrames: totalFrames,
    sourceFrameCount: totalFrames,
    decodeGaps: 0,
    derivedFps: fps,
    alignment: 'presentation_time_estimate',
    method: 'seek-estimate',
  };
}

/**
 * Process presented source frames.  Playback is paused in each RVFC callback
 * until that exact frame has been snapshotted and consumed.  The next callback
 * is registered before playback resumes, so inference latency cannot create
 * decoder gaps merely by applying backpressure.
 */
export async function processVideoFile(metadata: LocalVideoMetadata, options: ProcessVideoOptions): Promise<ProcessVideoResult> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  // One internal signal owns every event waiter created for this temporary
  // element. Aborting it in finally removes listeners even when assigning src
  // or load() throws synchronously.
  const lifecycle = new AbortController();
  const relayAbort = () => lifecycle.abort();
  if (options.signal?.aborted) lifecycle.abort();
  else options.signal?.addEventListener('abort', relayAbort, { once: true });
  const scopedOptions: ProcessVideoOptions = { ...options, signal: lifecycle.signal };
  try {
    if (lifecycle.signal.aborted) throw abortError();
    const metadataReady = waitForMediaEvent(video, 'loadedmetadata', lifecycle.signal);
    void metadataReady.catch(() => undefined);
    video.src = metadata.url;
    video.load();
    await metadataReady;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMediaEvent(video, 'loadeddata', lifecycle.signal);
    }
    if (typeof video.requestVideoFrameCallback === 'function' && canSnapshotPresentedFrame()) {
      return await processWithRvfc(video, metadata, scopedOptions);
    }
    return await processWithSeekFallback(video, metadata, scopedOptions);
  } finally {
    lifecycle.abort();
    options.signal?.removeEventListener('abort', relayAbort);
    releaseVideoElement(video);
  }
}

export function revokeVideoUrl(metadata: LocalVideoMetadata | undefined): void {
  if (metadata?.url) URL.revokeObjectURL(metadata.url);
}
