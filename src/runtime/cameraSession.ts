export interface CameraCapabilities {
  secureContext: boolean;
  camera: boolean;
  workers: boolean;
  wasm: boolean;
  videoFrameCallback: boolean;
}

export interface CameraMetadata {
  width: number;
  height: number;
  frameRate?: number;
  facingMode?: string;
  deviceId?: string;
}

export interface CameraFrame {
  image: HTMLVideoElement;
  mediaTime: number;
  presentedFrames?: number;
  expectedDisplayTime?: number;
  width: number;
  height: number;
}

/** Lifecycle of the media stream itself (independent from the frame callback loop). */
export type CameraSessionState = 'idle' | 'requesting' | 'running' | 'ended' | 'stopped';

export interface CameraSessionCallbacks {
  /** Called when the active video track ends outside of an explicit stop(). */
  onEnded?: (event: Event) => void;
  /** Called after a lifecycle transition. The callback is never called for a no-op transition. */
  onStateChange?: (state: CameraSessionState, previousState: CameraSessionState) => void;
}

type VideoFrameCallback = VideoFrameRequestCallback;

/**
 * Camera APIs are available in secure contexts, with the standard loopback
 * exceptions used by local development. Keep this predicate shared with the
 * UI capability check so a localhost preview cannot disagree with request().
 */
export function isCameraSecureContext(): boolean {
  if (typeof window === 'undefined') return true;
  const hostname = window.location.hostname.toLowerCase();
  return window.isSecureContext
    || hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

export function checkCameraCapabilities(): CameraCapabilities {
  return {
    secureContext: isCameraSecureContext(),
    camera: typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),
    workers: typeof Worker !== 'undefined',
    wasm: typeof WebAssembly !== 'undefined',
    videoFrameCallback: typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  };
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError': return 'Camera permission was denied. Check the browser permission and try again.';
    case 'NotFoundError': return 'No camera device was found.';
    case 'NotReadableError': return 'The camera is busy or could not be read.';
    case 'OverconstrainedError': return 'The requested camera constraints are unavailable.';
    case 'SecurityError': return 'Camera access requires HTTPS or localhost.';
    default: return error instanceof Error ? error.message : 'Camera initialization failed.';
  }
}

export class CameraSession {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | undefined;
  private callbackHandle: number | undefined;
  private running = false;
  private mirror = true;
  private lifecycleState: CameraSessionState = 'idle';
  private callbacks: CameraSessionCallbacks;
  // getUserMedia cannot be cancelled. A generation check makes a late result
  // harmless and ensures an old camera cannot replace a newer selection.
  private requestGeneration = 0;
  private activeTrack: MediaStreamTrack | undefined;
  private activeTrackEndedListener: ((event: Event) => void) | undefined;

  constructor(video?: HTMLVideoElement, callbacks: CameraSessionCallbacks = {}) {
    this.video = video ?? document.createElement('video');
    this.callbacks = { ...callbacks };
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-label', 'Camera preview');
  }

  get mediaStream(): MediaStream | undefined { return this.stream; }
  get isMirrored(): boolean { return this.mirror; }
  get state(): CameraSessionState { return this.lifecycleState; }

  /** Replace observers without replacing the underlying media session. */
  setCallbacks(callbacks: CameraSessionCallbacks = {}): void {
    this.callbacks = { ...callbacks };
  }

  private setState(next: CameraSessionState): void {
    if (next === this.lifecycleState) return;
    const previous = this.lifecycleState;
    this.lifecycleState = next;
    try {
      this.callbacks.onStateChange?.(next, previous);
    } catch {
      // An observer must not break camera cleanup or cause request() to fail.
    }
  }

  private detachTrackListener(): void {
    const track = this.activeTrack;
    const listener = this.activeTrackEndedListener;
    if (track && listener && typeof track.removeEventListener === 'function') {
      track.removeEventListener('ended', listener);
    }
    this.activeTrack = undefined;
    this.activeTrackEndedListener = undefined;
  }

  private stopStream(stream: MediaStream | undefined): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* a partially detached device may already be stopped */ }
    }
  }

  private clearActiveStream(): void {
    const stream = this.stream;
    this.detachTrackListener();
    this.stream = undefined;
    // Do not let a late play() continuation clear a stream belonging to a new
    // request. At this point the session owns the element, so clearing it is safe.
    this.video.pause();
    this.video.srcObject = null;
    this.stopStream(stream);
  }

  private handleTrackEnded(stream: MediaStream, track: MediaStreamTrack, generation: number, event: Event): void {
    // A stale track can still dispatch an event after stop() in some browsers.
    // Check all three identities before publishing it to the application.
    if (generation !== this.requestGeneration || this.stream !== stream || this.activeTrack !== track) return;
    this.stopFrames();
    this.setState('ended');
    try {
      this.callbacks.onEnded?.(event);
    } catch {
      // Keep the session state authoritative even if a UI observer throws.
    }
  }

  private attachTrackListener(stream: MediaStream, track: MediaStreamTrack, generation: number): void {
    this.detachTrackListener();
    const listener = (event: Event) => this.handleTrackEnded(stream, track, generation, event);
    this.activeTrack = track;
    this.activeTrackEndedListener = listener;
    if (typeof track.addEventListener === 'function') {
      track.addEventListener('ended', listener);
    }
  }

  setMirror(value: boolean): void {
    this.mirror = value;
    this.video.style.transform = value ? 'scaleX(-1)' : 'none';
  }

  async enumerateCameras(): Promise<Array<{ id: string; label: string }>> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({ id: device.deviceId, label: device.label || `Camera ${index + 1}` }));
  }

  async request(deviceId?: string): Promise<CameraMetadata> {
    // Invalidate any unresolved getUserMedia call immediately. The browser
    // does not expose cancellation for that promise, so every new request
    // must advance the generation even when capability validation fails.
    const generation = ++this.requestGeneration;
    const capabilities = checkCameraCapabilities();
    if (!capabilities.secureContext) throw new DOMException('Camera access requires HTTPS', 'SecurityError');
    if (!capabilities.camera) throw new DOMException('Camera API unavailable', 'NotSupportedError');

    // Invalidate and clean up the previous stream without emitting an
    // intermediate `stopped` state. The caller observes the new request as one
    // continuous transition: requesting -> running (or idle on failure).
    this.stopFrames();
    this.clearActiveStream();
    this.setState('requesting');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 },
          facingMode: deviceId ? undefined : 'user',
        },
      });
    } catch (error) {
      if (generation !== this.requestGeneration) throw new DOMException('Camera request superseded', 'AbortError');
      this.setState('idle');
      throw error;
    }

    if (generation !== this.requestGeneration) {
      this.stopStream(stream);
      throw new DOMException('Camera request superseded', 'AbortError');
    }

    // Assign before awaiting play() so an explicit stop() during play can
    // release this stream as well.
    this.stream = stream;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (error) {
      if (generation !== this.requestGeneration) {
        if (this.stream === stream) this.clearActiveStream();
        // A superseding request may already have detached and stopped this
        // stream. Do not call track.stop() a second time in that case.
        throw new DOMException('Camera request superseded', 'AbortError');
      }
      if (this.stream === stream) this.clearActiveStream();
      this.setState('idle');
      throw error;
    }

    if (generation !== this.requestGeneration || this.stream !== stream) {
      if (this.stream === stream) this.clearActiveStream();
      // If the stream is no longer active, the request that replaced it owns
      // its cleanup and has already stopped its tracks.
      throw new DOMException('Camera request superseded', 'AbortError');
    }

    const track = stream.getVideoTracks()[0];
    if (track) {
      this.attachTrackListener(stream, track, generation);
      // A track can end while play() is settling, before the listener is
      // attached. Observe readyState so that transition is not lost.
      if (track.readyState === 'ended') {
        this.handleTrackEnded(stream, track, generation, new Event('ended'));
        // Do not report a successfully initialized camera after its only
        // video track has already ended. Callers would otherwise continue
        // into model setup and start a frame loop with a dead source.
        throw new DOMException('Camera track ended unexpectedly', 'NotReadableError');
      }
    }
    this.setState('running');
    const settings = track?.getSettings();
    return {
      width: this.video.videoWidth || settings?.width || 0,
      height: this.video.videoHeight || settings?.height || 0,
      frameRate: settings?.frameRate,
      facingMode: settings?.facingMode,
      deviceId: settings?.deviceId,
    };
  }

  startFrames(onFrame: (frame: CameraFrame) => void): void {
    this.stopFrames();
    this.running = true;
    const useVfc = typeof this.video.requestVideoFrameCallback === 'function';
    if (useVfc) {
      const tick: VideoFrameCallback = (_now, metadata) => {
        if (!this.running) return;
        onFrame({
          image: this.video,
          mediaTime: metadata.mediaTime,
          presentedFrames: metadata.presentedFrames,
          expectedDisplayTime: metadata.expectedDisplayTime,
          width: this.video.videoWidth,
          height: this.video.videoHeight,
        });
        this.callbackHandle = this.video.requestVideoFrameCallback?.(tick);
      };
      this.callbackHandle = this.video.requestVideoFrameCallback?.(tick);
      return;
    }
    const raf = () => {
      if (!this.running) return;
      onFrame({ image: this.video, mediaTime: this.video.currentTime, width: this.video.videoWidth, height: this.video.videoHeight });
      this.callbackHandle = requestAnimationFrame(raf);
    };
    this.callbackHandle = requestAnimationFrame(raf);
  }

  stopFrames(): void {
    this.running = false;
    if (this.callbackHandle !== undefined) {
      if (this.video.cancelVideoFrameCallback && typeof this.video.requestVideoFrameCallback === 'function') {
        this.video.cancelVideoFrameCallback(this.callbackHandle);
      } else if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.callbackHandle);
      }
    }
    this.callbackHandle = undefined;
  }

  stop(): void {
    ++this.requestGeneration;
    this.stopFrames();
    this.clearActiveStream();
    this.setState('stopped');
  }
}
