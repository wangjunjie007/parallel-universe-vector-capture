import type { SemanticFrame } from '../core/types';
import { drawSemanticEffects, type RegionEffect } from '../ui/regionEffects';

export interface EffectVideoExportOptions {
  sourceUrl: string;
  frames: readonly SemanticFrame[];
  width: number;
  height: number;
  effects: readonly RegionEffect[];
  onProgress?: (percent: number) => void;
}

function mimeType(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find((value) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(value)) ?? '';
}

function waitForEvent(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { target.removeEventListener(event, done); target.removeEventListener('error', fail); resolve(); };
    const fail = () => { target.removeEventListener(event, done); target.removeEventListener('error', fail); reject(new Error('Video decoding failed during effect export.')); };
    target.addEventListener(event, done, { once: true }); target.addEventListener('error', fail, { once: true });
  });
}

export async function renderEffectVideo(options: EffectVideoExportOptions): Promise<Blob> {
  if (!mimeType()) throw new Error('This browser does not support WebM video export.');
  const video = document.createElement('video');
  video.preload = 'auto'; video.playsInline = true; video.muted = false; video.volume = 1;
  const metadataReady = waitForEvent(video, 'loadedmetadata');
  video.src = options.sourceUrl;
  await metadataReady;
  const canvas = document.createElement('canvas'); canvas.width = options.width; canvas.height = options.height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas rendering is unavailable.');
  const canvasStream = canvas.captureStream(30);
  const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
  const sourceStream = typeof capture === 'function' ? capture.call(video) : undefined;
  sourceStream?.getAudioTracks().forEach((track: MediaStreamTrack) => canvasStream.addTrack(track));
  const recorder = new MediaRecorder(canvasStream, { mimeType: mimeType(), videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const completed = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('WebM recording failed.'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
  });
  const sorted = [...options.frames].sort((a, b) => a.time - b.time);
  let lastIndex = 0;
  const paint = (time: number) => {
    while (lastIndex + 1 < sorted.length && sorted[lastIndex + 1].time <= time) lastIndex += 1;
    const frame = sorted[lastIndex];
    ctx.clearRect(0, 0, options.width, options.height); ctx.drawImage(video, 0, 0, options.width, options.height);
    if (frame) drawSemanticEffects(ctx, frame.extendedPoints, options.width, options.height, [...options.effects], time);
    options.onProgress?.(Math.min(100, Math.round((time / Math.max(0.001, video.duration)) * 100)));
  };
  const frameCallback = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number }).requestVideoFrameCallback;
  recorder.start(250);
  const playbackDone = new Promise<void>((resolve, reject) => {
    video.addEventListener('ended', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('Video playback failed during effect export.')), { once: true });
    const tick = (_now: number, metadata: VideoFrameCallbackMetadata) => { paint(metadata.mediaTime); if (video.paused || video.ended) return; frameCallback?.call(video, tick); };
    if (frameCallback) frameCallback.call(video, tick);
    else { const loop = () => { paint(video.currentTime); if (!video.paused && !video.ended) requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
    void video.play().catch(() => reject(new Error('Browser blocked video playback for export.')));
  });
  await playbackDone;
  await new Promise((resolve) => setTimeout(resolve, 100));
  recorder.stop();
  const blob = await completed;
  video.pause(); video.removeAttribute('src'); video.load(); canvasStream.getTracks().forEach((track: MediaStreamTrack) => track.stop()); sourceStream?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
  options.onProgress?.(100);
  return blob;
}
