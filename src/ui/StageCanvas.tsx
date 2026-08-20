import { useEffect, useRef, useState } from 'react';
import type { RefObject, SyntheticEvent } from 'react';
import { Crosshair, EyeOff, Hand, Pause, Play, RotateCcw, ScanLine, Settings2, StepBack, StepForward, X } from 'lucide-react';
import type { CapturePhase, Language, OverlaySnapshot, ReplayActions, ReplaySnapshot, SourceSnapshot, UiHand, UiPoint, UiVector } from './types';
import { formatNumber } from './format';
import { t } from './i18n';
import { buildEffectRegions, FINGER_ORDER, type OverlayPosition } from './overlayGeometry';

export type ConnectionStyle = 'portal' | 'fingers' | 'bridges' | 'mesh';
export type RegionEffect = 'prism' | 'scanlines' | 'neon' | 'invert' | 'energy' | 'grid' | 'particles' | 'chromatic';
export interface OverlayVisualConfig { connections: ConnectionStyle[]; effects: RegionEffect[] }

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
  visualConfig: OverlayVisualConfig;
  onVisualConfigChange: (kind: 'connections' | 'effects', value: ConnectionStyle | RegionEffect) => void;
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

// Pinch coordinates intentionally stay almost coincident for semantic/export fidelity.
// Give the two overlay markers a small visual gap so they remain individually readable.
const MIN_PINCH_MARKER_GAP = 10;

const connectionColors: Record<ConnectionStyle, string> = { portal: '#91e7c2', fingers: '#8bd3dd', bridges: '#ffd166', mesh: '#c6a7ff' };
const regionPalettes = [
  ['#46d9a0', '#c6a7ff', '#ff9d83'],
  ['#8bd3dd', '#ffd166', '#ff7a90'],
  ['#c6a7ff', '#46d9a0', '#8bd3dd'],
  ['#ff9d83', '#ffd166', '#91e7c2'],
] as const;

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

  const renderPositions = new Map<UiPoint['finger'], { x: number; y: number }>();
  hand.points.forEach((point) => {
    if (point.visible !== false) renderPositions.set(point.finger, pointPosition(point, width, height, sourceWidth, sourceHeight, mirror));
  });
  const thumbPosition = renderPositions.get('thumb');
  const indexPosition = renderPositions.get('index');
  if (thumbPosition && indexPosition) {
    const dx = indexPosition.x - thumbPosition.x;
    const dy = indexPosition.y - thumbPosition.y;
    const distance = Math.hypot(dx, dy);
    if (distance < MIN_PINCH_MARKER_GAP) {
      const centerX = (thumbPosition.x + indexPosition.x) / 2;
      const centerY = (thumbPosition.y + indexPosition.y) / 2;
      const unitX = distance > 0.001 ? dx / distance : 1;
      const unitY = distance > 0.001 ? dy / distance : 0;
      const halfGap = MIN_PINCH_MARKER_GAP / 2;
      renderPositions.set('thumb', { x: centerX - unitX * halfGap, y: centerY - unitY * halfGap });
      renderPositions.set('index', { x: centerX + unitX * halfGap, y: centerY + unitY * halfGap });
    }
  }

  hand.points.forEach((point) => {
    if (point.visible === false) return;
    const position = renderPositions.get(point.finger) ?? pointPosition(point, width, height, sourceWidth, sourceHeight, mirror);
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

const drawConnection = (ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, style: ConnectionStyle) => {
  ctx.save(); ctx.strokeStyle = connectionColors[style]; ctx.globalAlpha = style === 'mesh' ? 0.22 : 0.7;
  ctx.lineWidth = style === 'portal' ? 2.1 : style === 'mesh' ? 0.8 : 1.25;
  if (style === 'fingers') ctx.setLineDash([5, 4]);
  if (style === 'bridges') ctx.setLineDash([2, 5]);
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.restore();
};

const polygonPath = (ctx: CanvasRenderingContext2D, corners: OverlayPosition[]) => {
  ctx.beginPath();
  corners.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
  ctx.closePath();
};

const drawRegionEffects = (ctx: CanvasRenderingContext2D, corners: OverlayPosition[], effects: RegionEffect[], regionIndex: number, frame: number) => {
  if (corners.length !== 4 || effects.length === 0) return;
  const palette = regionPalettes[regionIndex % regionPalettes.length];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;
  const centerX = left + width / 2;
  const centerY = top + height / 2;

  ctx.save();
  polygonPath(ctx, corners);
  ctx.clip();
  if (effects.includes('prism')) {
    const gradient = ctx.createLinearGradient(left, top, left + width, top + height);
    gradient.addColorStop(0, `${palette[0]}38`);
    gradient.addColorStop(0.5, `${palette[1]}24`);
    gradient.addColorStop(1, `${palette[2]}38`);
    ctx.fillStyle = gradient;
    ctx.fillRect(left, top, width, height);
  }
  if (effects.includes('scanlines')) { ctx.strokeStyle = 'rgba(145,231,194,.28)'; ctx.lineWidth = 1; for (let y = top; y < top + height; y += 6) { ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); } }
  if (effects.includes('invert')) { ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.fillRect(left, top, width, height); }
  if (effects.includes('energy')) {
    const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(width, height) * 0.7);
    glow.addColorStop(0, `${palette[0]}50`);
    glow.addColorStop(0.55, `${palette[1]}20`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(left, top, width, height);
  }
  if (effects.includes('grid')) {
    ctx.strokeStyle = `${palette[1]}42`;
    ctx.lineWidth = 0.75;
    for (let x = left; x <= left + width; x += 12) { ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke(); }
    for (let y = top; y <= top + height; y += 12) { ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); }
  }
  if (effects.includes('particles')) {
    ctx.fillStyle = `${palette[2]}b8`;
    for (let index = 0; index < 18; index += 1) {
      const x = left + ((((index * 37) + (regionIndex * 19) + frame) % 101) / 100) * width;
      const y = top + ((((index * 61) + (regionIndex * 11) + Math.floor(frame / 2)) % 97) / 96) * height;
      ctx.beginPath(); ctx.arc(x, y, index % 3 === 0 ? 1.6 : 0.9, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();

  if (effects.includes('neon')) {
    ctx.save();
    ctx.shadowColor = palette[0];
    ctx.shadowBlur = 16;
    ctx.strokeStyle = `${palette[0]}d0`;
    ctx.lineWidth = 1.8;
    polygonPath(ctx, corners);
    ctx.stroke();
    ctx.restore();
  }
  if (effects.includes('chromatic')) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    [[-2, 0, '#ff4f70'], [2, 0, '#45e6ff']].forEach(([dx, dy, color]) => {
      ctx.save(); ctx.translate(dx as number, dy as number); ctx.strokeStyle = color as string; ctx.globalAlpha = 0.58; ctx.lineWidth = 1.2; polygonPath(ctx, corners); ctx.stroke(); ctx.restore();
    });
    ctx.restore();
  }
};

function useCanvasDrawing(canvasRef: RefObject<HTMLCanvasElement>, overlay: OverlaySnapshot, source: SourceSnapshot, mirror: boolean, visualConfig: OverlayVisualConfig) {
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
      const positions = new Map<string, { x: number; y: number }>();
      overlay.hands.forEach((hand) => hand.points.forEach((point) => { if (point.visible !== false) positions.set(`${point.side}:${point.finger}`, pointPosition(point, width, height, sourceWidth, sourceHeight, mirror)); }));
      const get = (id: string) => positions.get(id);
      const includeMultiPointCells = visualConfig.connections.some((style) => style !== 'portal');
      const regions = buildEffectRegions(positions, visualConfig.connections.includes('portal'), includeMultiPointCells);
      regions.forEach((region, index) => drawRegionEffects(ctx, region.corners, visualConfig.effects, index, overlay.sourceFrame ?? 0));
      if (visualConfig.connections.includes('portal')) {
        const corners = ['hand_1:thumb', 'hand_1:index', 'hand_2:index', 'hand_2:thumb'].map(get).filter((p): p is { x: number; y: number } => Boolean(p));
        if (corners.length === 4) corners.forEach((point, index) => drawConnection(ctx, point, corners[(index + 1) % corners.length], 'portal'));
      }
      if (visualConfig.connections.includes('fingers')) overlay.hands.forEach((hand) => { const points = FINGER_ORDER.map((finger) => get(`${hand.side}:${finger}`)).filter((p): p is { x: number; y: number } => Boolean(p)); points.forEach((point, index) => { if (index) drawConnection(ctx, points[index - 1], point, 'fingers'); }); });
      if (visualConfig.connections.includes('bridges')) FINGER_ORDER.forEach((finger) => { const left = get(`hand_1:${finger}`); const right = get(`hand_2:${finger}`); if (left && right) drawConnection(ctx, left, right, 'bridges'); });
      if (visualConfig.connections.includes('mesh')) { const points = [...positions.values()]; points.forEach((p, i) => points.slice(i + 1).forEach((other) => drawConnection(ctx, p, other, 'mesh'))); }
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
  }, [canvasRef, mirror, overlay, source, visualConfig]);
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
  visualConfig,
  onVisualConfigChange,
}: StageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visualPanelOpen, setVisualPanelOpen] = useState(false);
  useCanvasDrawing(canvasRef, overlay, source, mirror, visualConfig);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.style.setProperty('transform', mirror ? 'scaleX(-1)' : 'none', 'important');
    video.style.transformOrigin = 'center center';
    if (videoStream && video.srcObject !== videoStream) video.srcObject = videoStream;
    if (!videoStream && video.srcObject) video.srcObject = null;
    if (videoUrl && video.src !== videoUrl) video.src = videoUrl;
    if (!videoUrl && source.kind !== 'file' && source.kind !== 'recording') video.removeAttribute('src');
    if ((videoStream || videoUrl) && !replay?.ready) void video.play().catch(() => undefined);
  }, [mirror, source.kind, videoRef, videoStream, videoUrl, replay?.ready]);

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
          <button type="button" className="stage-effects-button" onClick={() => setVisualPanelOpen((open) => !open)} aria-expanded={visualPanelOpen} aria-label={language === 'zh' ? '打开连线与特效设置' : 'Open connection and effect settings'} title={language === 'zh' ? '连线与特效' : 'Connections and effects'}><Settings2 size={14} /><span>{language === 'zh' ? '连线 / 特效' : 'Lines / FX'}</span></button>
        </div>
      </div>
      <div className={`stage-viewport ${hasSource ? 'has-source' : 'is-empty'} phase-${phase}`} style={{ aspectRatio }}>
        {visualPanelOpen ? <div className="stage-visual-panel" role="dialog" aria-label={language === 'zh' ? '连线与区域特效' : 'Connections and region effects'}>
          <div className="stage-visual-panel-heading"><strong>{language === 'zh' ? '连线与区域特效' : 'Connections and region effects'}</strong><button type="button" className="icon-button" onClick={() => setVisualPanelOpen(false)} aria-label={language === 'zh' ? '关闭设置' : 'Close settings'} title={language === 'zh' ? '关闭' : 'Close'}><X size={14} /></button></div>
          <div className="visual-controls-title">{language === 'zh' ? '连线样式（可多选）' : 'Connection styles (multi-select)'}</div>
          <div className="visual-options">{([['portal', language === 'zh' ? '门户外框' : 'Portal frame'], ['fingers', language === 'zh' ? '手指链' : 'Finger chains'], ['bridges', language === 'zh' ? '同名桥接' : 'Matching bridges'], ['mesh', language === 'zh' ? '全连接网格' : 'Complete mesh']] as [ConnectionStyle, string][]).map(([value, label]) => <label key={value}><input type="checkbox" checked={visualConfig.connections.includes(value)} onChange={() => onVisualConfigChange('connections', value)} /><span>{label}</span></label>)}</div>
          <div className="visual-controls-title">{language === 'zh' ? '矩形区域特效（可多选）' : 'Rectangle effects (multi-select)'}</div>
          <div className="visual-options">{([['prism', language === 'zh' ? '棱镜色散' : 'Prism'], ['scanlines', language === 'zh' ? '扫描线' : 'Scanlines'], ['neon', language === 'zh' ? '霓虹辉光' : 'Neon glow'], ['invert', language === 'zh' ? '反相闪烁' : 'Invert flash'], ['energy', language === 'zh' ? '能量场' : 'Energy field'], ['grid', language === 'zh' ? '数字网格' : 'Digital grid'], ['particles', language === 'zh' ? '粒子流' : 'Particles'], ['chromatic', language === 'zh' ? '色差边缘' : 'Chromatic edge']] as [RegionEffect, string][]).map(([value, label]) => <label key={value}><input type="checkbox" checked={visualConfig.effects.includes(value)} onChange={() => onVisualConfigChange('effects', value)} /><span>{label}</span></label>)}</div>
        </div> : null}
        <video
          className={`stage-video ${mirror ? 'is-mirrored' : ''}`}
          style={{ transform: mirror ? 'scaleX(-1)' : 'none' }}
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
