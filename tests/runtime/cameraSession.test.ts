import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CameraSession,
  checkCameraCapabilities,
  isCameraSecureContext,
  type CameraSessionState,
} from '../../src/runtime/cameraSession';

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  readonly stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  readonly getSettings = vi.fn(() => ({
    width: 640,
    height: 360,
    frameRate: 30,
    deviceId: 'fake-device',
    facingMode: 'user',
  }));
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}

  getVideoTracks(): FakeTrack[] { return [this.track]; }
  getTracks(): FakeTrack[] { return [this.track]; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function fakeVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  let source: MediaStream | null = null;
  Object.defineProperty(video, 'srcObject', {
    configurable: true,
    get: () => source,
    set: (value: MediaStream | null) => { source = value; },
  });
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 640 });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: 360 });
  Object.defineProperty(video, 'play', { configurable: true, value: vi.fn(async () => undefined) });
  Object.defineProperty(video, 'pause', { configurable: true, value: vi.fn() });
  // Avoid jsdom's requestAnimationFrame implementation affecting lifecycle tests.
  Object.defineProperty(video, 'requestVideoFrameCallback', { configurable: true, value: undefined });
  return video;
}

function installMediaDevices(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  return () => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  };
}

describe('CameraSession lifecycle', () => {
  let restoreMediaDevices: (() => void) | undefined;

  afterEach(() => {
    restoreMediaDevices?.();
    restoreMediaDevices = undefined;
    vi.restoreAllMocks();
  });

  it('publishes running and ended transitions for the active track', async () => {
    const track = new FakeTrack();
    const stream = new FakeStream(track) as unknown as MediaStream;
    const states: CameraSessionState[] = [];
    const ended = vi.fn();
    restoreMediaDevices = installMediaDevices(vi.fn(async () => stream));
    const session = new CameraSession(fakeVideo(), {
      onEnded: ended,
      onStateChange: (state) => states.push(state),
    });

    await expect(session.request()).resolves.toMatchObject({ width: 640, height: 360, frameRate: 30 });
    expect(session.state).toBe('running');
    expect(states).toEqual(['requesting', 'running']);

    track.dispatchEvent(new Event('ended'));
    expect(session.state).toBe('ended');
    expect(ended).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['requesting', 'running', 'ended']);
  });

  it('retains ended state when the track has already ended before listener attachment', async () => {
    const track = new FakeTrack();
    track.readyState = 'ended';
    const stream = new FakeStream(track) as unknown as MediaStream;
    const ended = vi.fn();
    restoreMediaDevices = installMediaDevices(vi.fn(async () => stream));
    const session = new CameraSession(fakeVideo(), { onEnded: ended });

    await expect(session.request()).rejects.toMatchObject({ name: 'NotReadableError' });
    expect(session.state).toBe('ended');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('supersedes a pending request and stops its late stream', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    restoreMediaDevices = installMediaDevices(getUserMedia);
    const ended = vi.fn();
    const session = new CameraSession(fakeVideo(), { onEnded: ended });

    const firstRequest = session.request('device-a');
    const secondRequest = session.request('device-b');
    const firstTrack = new FakeTrack();
    const firstStream = new FakeStream(firstTrack) as unknown as MediaStream;
    first.resolve(firstStream);
    await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(session.mediaStream).toBeUndefined();

    const secondTrack = new FakeTrack();
    const secondStream = new FakeStream(secondTrack) as unknown as MediaStream;
    second.resolve(secondStream);
    await expect(secondRequest).resolves.toMatchObject({ deviceId: 'fake-device' });
    expect(session.mediaStream).toBe(secondStream);
    expect(session.state).toBe('running');

    // A stale track event must not affect the new stream's state or observers.
    firstTrack.dispatchEvent(new Event('ended'));
    expect(ended).not.toHaveBeenCalled();
    expect(session.state).toBe('running');
  });

  it('removes the active track listener and invalidates requests on stop', async () => {
    const track = new FakeTrack();
    const stream = new FakeStream(track) as unknown as MediaStream;
    const ended = vi.fn();
    restoreMediaDevices = installMediaDevices(vi.fn(async () => stream));
    const session = new CameraSession(fakeVideo(), { onEnded: ended });

    await session.request();
    session.stop();
    expect(session.state).toBe('stopped');
    expect(session.mediaStream).toBeUndefined();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();

    track.dispatchEvent(new Event('ended'));
    expect(ended).not.toHaveBeenCalled();
    expect(session.state).toBe('stopped');
  });

  it('invalidates a pending getUserMedia request when stopped', async () => {
    const pending = deferred<MediaStream>();
    restoreMediaDevices = installMediaDevices(vi.fn(() => pending.promise));
    const session = new CameraSession(fakeVideo());
    const request = session.request();

    session.stop();
    const track = new FakeTrack();
    pending.resolve(new FakeStream(track) as unknown as MediaStream);

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(session.state).toBe('stopped');
    expect(session.mediaStream).toBeUndefined();
  });

  it('does not let a late play resolve replace a newer stream', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    restoreMediaDevices = installMediaDevices(getUserMedia);
    const video = fakeVideo();
    const playDeferred = deferred<void>();
    Object.defineProperty(video, 'play', { configurable: true, value: vi.fn(() => playDeferred.promise) });
    const session = new CameraSession(video);

    const firstRequest = session.request('device-a');
    const firstTrack = new FakeTrack();
    const firstStream = new FakeStream(firstTrack) as unknown as MediaStream;
    first.resolve(firstStream);
    await Promise.resolve();

    const secondRequest = session.request('device-b');
    const secondTrack = new FakeTrack();
    const secondStream = new FakeStream(secondTrack) as unknown as MediaStream;
    second.resolve(secondStream);
    // Resolve the first play after the replacement request has started.
    playDeferred.resolve();
    await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' });
    await expect(secondRequest).resolves.toBeDefined();
    expect(firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(session.mediaStream).toBe(secondStream);
  });
});

describe('camera secure-context detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['[::1]', true],
    ['::1', true],
    ['capture.example', false],
  ])('recognizes %s as secure=%s', (hostname, expected) => {
    vi.stubGlobal('window', {
      isSecureContext: false,
      location: { hostname },
    });

    expect(isCameraSecureContext()).toBe(expected);
    expect(checkCameraCapabilities().secureContext).toBe(expected);
  });

  it('accepts a secure remote origin even when it is not loopback', () => {
    vi.stubGlobal('window', {
      isSecureContext: true,
      location: { hostname: 'capture.example' },
    });

    expect(isCameraSecureContext()).toBe(true);
  });
});
