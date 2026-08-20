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

type VideoFrameCallback = VideoFrameRequestCallback;

export function checkCameraCapabilities(): CameraCapabilities {
  return {
    secureContext: typeof window === 'undefined' || window.isSecureContext || window.location.hostname === 'localhost',
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

  constructor(video?: HTMLVideoElement) {
    this.video = video ?? document.createElement('video');
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-label', 'Camera preview');
  }

  get mediaStream(): MediaStream | undefined { return this.stream; }
  get isMirrored(): boolean { return this.mirror; }

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
    const capabilities = checkCameraCapabilities();
    if (!capabilities.secureContext) throw new DOMException('Camera access requires HTTPS', 'SecurityError');
    if (!capabilities.camera) throw new DOMException('Camera API unavailable', 'NotSupportedError');
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: deviceId ? undefined : 'user',
      },
    });
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => { this.running = false; });
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
    this.stopFrames();
    this.video.pause();
    this.video.srcObject = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}
