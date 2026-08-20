import { useEffect, useRef } from 'react';
import type { RefObject, SyntheticEvent } from 'react';
import { Crosshair, EyeOff, Hand, Pause, Play, RotateCcw, ScanLine, StepBack, StepForward } from 'lucide-react';
import type { CapturePhase, Language, OverlaySnapshot, ReplayActions, ReplaySnapshot, SourceSnapshot, UiHand, UiPoint, UiVector } from './types';
import { formatNumber } from './format';
import { t } from './i18n';

interface StageCanvasProps {
  language: Language;
  source: SourceSnapshot;
  overlay: OverlaySnapshot;
  phase: CapturePhase;
  mirror: boolean;
  videoStream?: MediaStream | null;
  videoUrl?: string;
  videoRef: RefObject<HTMLVideoElement>;
  onVideoMetadata?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onVideoError?: () => void;
  replay?: ReplaySnapshot;
  replayActions?: Partial<ReplayActions>;
  /** Called with the media clock as the visible video advances or seeks. */
  onReplayTime?: (time: number) => void;
}

const handColors: Record<UiHand['side'], string> = {
  hand_1: '#91e7c2',
  hand_2: '#ff9d83',
};

const fingerColors: Record<UiPoint['finger'], string> = {
  thumb: '#ffd166',
  index: '#91e7c2',
  middle: '#8bd3dd',
  ring: '#c6a7ff',
  little: '#ff9d83',
};

const pointPosition = (point: UiVector, width: number, height: number, sourceWidth: number, sourceHeight: number, mirror: boolean) => {
  const rawX = point.nx !== undefined ? point.nx * width : (sourceWidth > 0 ? (point.x / sourceWidth) * width : point.x);
  const rawY = point.ny !== undefined ? point.ny * height : (sourceHeight > 0 ? (point.y / sourceHeight) * height : point.y);
  return { x: mirror ? width - rawX : rawX, y: rawY };
};

const drawTrail = (ctx: CanvasRenderingContext2D, trail: UiVector[], hand: UiHand, width: number, height: number, sourceWidth: number, sourceHeight: number, mirror: boolean) => {
  if (trail.length < 2) return;
  ctx.save();
  ctx.strokeStyle = handColors[hand.side];
  ctx.globalAlpha = 0.26;
  ctx.lineWidth = 1.25;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  trail.forEach((point, index) => {
    const position = pointPosition(point, width, height, sourceWidth, sourceHeight, mirror);
    if (index === 0) ctx.moveTo(position.x, position.y);
    else ctx.lineTo(position.x, position.y);
  });
  ctx.stroke();
  ctx.restore();
};

const drawHand = (ctx: CanvasRenderingContext2D, hand: UiHand, width: number, height: number, sourceWidth: number, sourceHeight: number, mirror: boolean) => {
  const color = handColors[hand.side];
  if (hand.trail) drawTrail(ctx, hand.trail, hand, width, height, sourceWidth, sourceHeight, mirror);
  hand.points.forEach((point) => {
    if (point.visible === false) return;
    if (point.trail) drawTrail(ctx, point.trail, hand, width, height, sourceWidth, sourceHeight, mirror);
  });

  if (hand.palm) {
    const palm = pointPosition(hand.palm, width, height, sourceWidth, sourceHeight, mirror);
    const radius = Math.max(8, Math.min(28, (hand.scale ?? 48) / Math.max(sourceWidth, 1) * width * 0.22));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(palm.x, palm.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(palm.x, palm.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  hand.points.forEach((point) => {
    if (point.visible === false) return;
    const position = pointPosition(point, width, height, sourceWidth, sourceHeight, mirror);
    const pointColor = fingerColors[point.finger];
    ctx.save();
    ctx.fillStyle = pointColor;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = point.interpolated ? 0.48 : 0.96;
    ctx.beginPath();
    ctx.arc(position.x, position.y, point.finger === 'thumb' || point.finger === 'index' ? 4.5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
};

function useCanvasDrawing(canvasRef: RefObject<HTMLCanvasElement>, overlay: OverlaySnapshot, source: SourceSnapshot, mirror: boolean) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    if (!host) return;
    const draw = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const sourceWidth = source.width || overlay.width || 1;
      const sourceHeight = source.height || overlay.height || 1;
      overlay.hands.forEach((hand) => drawHand(ctx, hand, width, height, sourceWidth, sourceHeight, mirror));
      if (overlay.hands.length > 0) {
        ctx.save();
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'middle';
        overlay.hands.forEach((hand) => {
          const point = hand.palm ?? hand.points[0];
          if (!point) return;
          const position = pointPosition(point, width, height, sourceWidth, sourceHeight, mirror);
          const label = `${hand.side === 'hand_1' ? 'H1' : 'H2'} · ${hand.state}`;
          const labelX = Math.max(6, Math.min(width - 86, position.x + 10));
          const labelY = Math.max(13, Math.min(height - 13, position.y - 11));
          ctx.fillStyle = 'rgba(7, 14, 16, 0.82)';
          ctx.fillRect(labelX - 4, labelY - 8, ctx.measureText(label).width + 9, 16);
          ctx.fillStyle = handColors[hand.side];
          ctx.fillText(label, labelX, labelY);
        });
        ctx.restore();
      }
    };
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [canvasRef, mirror, overlay, source]);
}

export function StageCanvas({
  language,
  source,
  overlay,
  phase,
  mirror,
  videoStream,
  videoUrl,
  videoRef,
  onVideoMetadata,
  onVideoError,
  replay,
  replayActions,
  onReplayTime,
}: StageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useCanvasDrawing(canvasRef, overlay, source, mirror);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (videoStream && video.srcObject !== videoStream) video.srcObject = videoStream;
    if (!videoStream && video.srcObject) video.srcObject = null;
    if (videoUrl && video.src !== videoUrl) video.src = videoUrl;
    if (!videoUrl && source.kind !== 'file' && source.kind !== 'recording') video.removeAttribute('src');
    if ((videoStream || videoUrl) && !replay?.ready) void video.play().catch(() => undefined);
  }, [source.kind, videoRef, videoStream, videoUrl, replay?.ready]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !replay?.ready) return;
    let stopped = false;
    let callbackId: number | undefined;
    const notify = () => {
      if (!stopped) onReplayTime?.(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    };
    const onTimeUpdate = () => notify();
    const onSeeking = () => notify();
    const onPlay = () => notify();
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', notify);
    video.addEventListener('ended', notify);
    const requestFrame = (video as unknown as { requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number }).requestVideoFrameCallback;
    if (typeof requestFrame === 'function') {
      const tick = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (stopped) return;
        onReplayTime?.(metadata.mediaTime);
        callbackId = requestFrame.call(video, tick);
      };
      callbackId = requestFrame.call(video, tick);
    }
    notify();
    return () => {
      stopped = true;
      if (callbackId !== undefined && 'cancelVideoFrameCallback' in video) {
        (video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void }).cancelVideoFrameCallback?.(callbackId);
      }
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', notify);
      video.removeEventListener('ended', notify);
    };
  }, [onReplayTime, replay?.ready, videoRef]);

  const hasSource = source.kind !== 'none' || Boolean(videoStream || videoUrl);
  const statusLabel = phase === 'recording' ? t(language, 'recording') : phase === 'preview' ? t(language, 'preview') : phase === 'processing' ? t(language, 'processing') : phase === 'complete' ? t(language, 'complete') : t(language, 'idle');
  const aspectRatio = source.width > 0 && source.height > 0 ? `${source.width} / ${source.height}` : '16 / 9';

  return (
    <section className="stage-panel" aria-label={t(language, 'stageWaiting')}>
      <div className="stage-toolbar">
        <div className="stage-title">
          <span className="live-indicator" aria-hidden="true" />
          <span>{statusLabel}</span>
          <span className="stage-separator">/</span>
          <span className="stage-source">{source.kind === 'camera' ? t(language, 'sourceCamera') : source.kind === 'file' ? t(language, 'sourceFile') : source.kind === 'recording' ? t(language, 'sourceRecording') : t(language, 'source')}</span>
        </div>
        <div className="stage-toolbar-meta">
          <span>{source.width > 0 ? `${source.width} × ${source.height}` : '—'}</span>
          <span aria-hidden="true">·</span>
          <span>{overlay.semanticCount} {t(language, 'count')}</span>
        </div>
      </div>
      <div className={`stage-viewport ${hasSource ? 'has-source' : 'is-empty'} phase-${phase}`} style={{ aspectRatio }}>
        <video
          className={`stage-video ${mirror ? 'is-mirrored' : ''}`}
          ref={videoRef}
          muted
          autoPlay={!replay?.ready}
          playsInline
          onLoadedMetadata={onVideoMetadata}
          onError={onVideoError}
          aria-label={source.name ?? t(language, 'stageWaiting')}
        />
        <canvas className="stage-overlay" ref={canvasRef} aria-hidden="true" />
        {!hasSource ? (
          <div className="stage-empty" role="status" aria-live="polite">
            <div className="empty-mark"><Crosshair size={21} strokeWidth={1.5} /></div>
            <strong>{t(language, 'stageWaiting')}</strong>
            <span>{t(language, 'stageWaitingDetail')}</span>
            <div className="empty-hints"><span><CameraGlyph /></span><span><ScanLine size={13} /></span><span><Hand size={13} /></span></div>
          </div>
        ) : null}
        {hasSource && overlay.hands.length === 0 ? (
          <div className="stage-model-waiting" role="status" aria-live="polite">
            <span className="model-pulse" aria-hidden="true" />
            <strong>{t(language, 'stageModelWaiting')}</strong>
            <span>{t(language, 'stageModelWaitingDetail')}</span>
          </div>
        ) : null}
        {overlay.isSample ? <span className="sample-badge"><EyeOff size={12} /> {t(language, 'stageSample')}</span> : null}
        <div className="stage-readout" aria-live="polite">
          <span>{t(language, 'frame')} {overlay.sourceFrame ?? '—'}</span>
          <span>{t(language, 'time')} {formatNumber(overlay.sourceTime, 3)}s</span>
        </div>
      </div>
      {replay?.ready && replayActions?.seekReplay && replayActions.playReplay && replayActions.pauseReplay && replayActions.restartReplay && replayActions.stepReplay ? (() => {
        const actions = replayActions as ReplayActions;
        return (
        <div className="replay-controls" aria-label={t(language, 'replayControls')}>
          <div className="replay-buttons">
            <button type="button" className="icon-button replay-icon-button" onClick={() => void actions.restartReplay()} aria-label={t(language, 'replayRestart')} title={t(language, 'replayRestart')}>
              <RotateCcw size={15} />
            </button>
            <button type="button" className="icon-button replay-icon-button" onClick={() => void actions.stepReplay(-1)} aria-label={t(language, 'replayPrevious')} title={t(language, 'replayPrevious')}>
              <StepBack size={15} />
            </button>
            {replay.playing ? (
              <button type="button" className="icon-button replay-icon-button replay-primary" onClick={actions.pauseReplay} aria-label={t(language, 'replayPause')} title={t(language, 'replayPause')}>
                <Pause size={16} />
              </button>
            ) : (
              <button type="button" className="icon-button replay-icon-button replay-primary" onClick={() => void actions.playReplay()} aria-label={t(language, 'replayPlay')} title={t(language, 'replayPlay')}>
                <Play size={16} />
              </button>
            )}
            <button type="button" className="icon-button replay-icon-button" onClick={() => void actions.stepReplay(1)} aria-label={t(language, 'replayNext')} title={t(language, 'replayNext')}>
              <StepForward size={15} />
            </button>
          </div>
          <input
            className="replay-timeline"
            type="range"
            min={0}
            max={Math.max(replay.duration, 0.001)}
            step={0.001}
            value={Math.min(Math.max(replay.currentTime, 0), Math.max(replay.duration, 0.001))}
            onChange={(event) => void actions.seekReplay(Number(event.target.value))}
            aria-label={t(language, 'replayTimeline')}
          />
          <span className="replay-timecode">{formatNumber(replay.currentTime, 2)} / {formatNumber(replay.duration, 2)}s</span>
        </div>
        );
      })() : null}
      <div className="stage-footnote">
        <span>{t(language, 'secureNote')}</span>
        <span>{source.orientationLabel ?? `${t(language, 'orientation')} ${source.rotation}°`}</span>
      </div>
    </section>
  );
}

function CameraGlyph() {
  return <span className="camera-glyph" aria-hidden="true" />;
}
