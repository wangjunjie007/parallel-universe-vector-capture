import { useEffect, useRef, useState } from 'react';
import type { RefObject, SyntheticEvent } from 'react';
import { Crosshair, EyeOff, Hand, Pause, Play, RotateCcw, ScanLine, Settings2, StepBack, StepForward, X } from 'lucide-react';
import type { CapturePhase, Language, OverlaySnapshot, ReplayActions, ReplaySnapshot, SourceSnapshot, UiHand, UiPoint, UiVector } from './types';
import { formatNumber } from './format';
import { t } from './i18n';
import { buildEffectRegions, FINGER_ORDER, type OverlayPosition } from './overlayGeometry';
import { drawRegionEffects as drawStyledRegionEffects } from './regionEffects';

export type ConnectionStyle = 'portal' | 'fingers' | 'bridges' | 'mesh' | 'fine';
export type RegionEffect = 'aurora' | 'prismatic' | 'invertCascade' | 'kaleido' | 'liquidChromatic' | 'energyBloom' | 'comicInk' | 'thermal' | 'posterInvert' | 'noirGraphic' | 'channelShift';
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

const connectionColors: Record<ConnectionStyle, string> = { portal: '#91e7c2', fingers: '#8bd3dd', bridges: '#ffd166', mesh: '#c6a7ff', fine: '#d7fff0' };
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
  ctx.save(); ctx.strokeStyle = connectionColors[style]; ctx.globalAlpha = style === 'mesh' ? 0.22 : style === 'fine' ? 0.46 : 0.7;
  ctx.lineWidth = style === 'portal' ? 2.1 : style === 'mesh' ? 0.8 : style === 'fine' ? 0.55 : 1.25;
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
  const xs = corners.map((point) => point.x); const ys = corners.map((point) => point.y);
  const left = Math.min(...xs); const top = Math.min(...ys); const width = Math.max(...xs) - left; const height = Math.max(...ys) - top;
  const cx = left + width / 2; const cy = top + height / 2; const phase = frame * 0.018 + regionIndex * 1.7;
  ctx.save(); polygonPath(ctx, corners); ctx.clip();

  // Every selected treatment paints the complete clipped face with layered color fields.
  const paintField = (offset: number, alpha: number, mode: GlobalCompositeOperation = 'source-over') => {
    ctx.save(); ctx.globalCompositeOperation = mode; ctx.globalAlpha = alpha;
    const gradient = ctx.createLinearGradient(left + Math.cos(phase + offset) * width, top, left + width, top + Math.sin(phase + offset) * height);
    gradient.addColorStop(0, palette[(regionIndex + 0) % 3]); gradient.addColorStop(0.38, palette[(regionIndex + 1) % 3]); gradient.addColorStop(0.72, palette[(regionIndex + 2) % 3]); gradient.addColorStop(1, '#071013');
    ctx.fillStyle = gradient; ctx.fillRect(left, top, width, height); ctx.restore();
  };
  const paintBlob = (x: number, y: number, radius: number, color: string, alpha: number, mode: GlobalCompositeOperation = 'screen') => {
    ctx.save(); ctx.globalCompositeOperation = mode; ctx.globalAlpha = alpha;
    const blob = ctx.createRadialGradient(x, y, 0, x, y, radius); blob.addColorStop(0, color); blob.addColorStop(0.45, `${color}aa`); blob.addColorStop(1, `${color}00`);
    ctx.fillStyle = blob; ctx.fillRect(left, top, width, height); ctx.restore();
  };
  // The visual language follows the open-source LiquidGlass shader approach: transparent
  // refraction-like passes, animated color matrices and chromatic separation, rather than
  // opaque stripes or a single static filter.
  // Keep the aggregate veil light even when several filters are selected together.
  const veil = Math.min(1, 1 / Math.max(1, effects.length * 0.72));
  const translucent = (alpha: number) => alpha * veil;
  paintField(0, translucent(0.18));
  const colorPass = (filter: string, alpha: number, mode: GlobalCompositeOperation = 'screen') => {
    ctx.save(); ctx.globalCompositeOperation = mode; ctx.globalAlpha = alpha; ctx.filter = filter;
    const gradient = ctx.createLinearGradient(left + Math.sin(phase * 1.7) * width, top + height, left + width, top - Math.cos(phase * 1.2) * height);
    gradient.addColorStop(0, palette[0]); gradient.addColorStop(0.28, palette[1]); gradient.addColorStop(0.58, palette[2]); gradient.addColorStop(1, '#f8fbff');
    ctx.fillStyle = gradient; ctx.fillRect(left - width * 0.15, top - height * 0.15, width * 1.3, height * 1.3); ctx.restore();
  };
  if (effects.includes('aurora')) { colorPass(`hue-rotate(${Math.sin(phase) * 80}deg) saturate(2.3) contrast(1.35)`, translucent(0.16)); colorPass(`blur(${Math.max(2, width * 0.025)}px) hue-rotate(${phase * 38}deg) saturate(2.8)`, translucent(0.08), 'overlay'); }
  if (effects.includes('prismatic')) { colorPass(`hue-rotate(${phase * 72}deg) saturate(3.8) contrast(1.5)`, translucent(0.14), 'screen'); colorPass(`blur(${Math.max(1, width * 0.012)}px) hue-rotate(${180 + phase * 44}deg)`, translucent(0.08), 'difference'); }
  if (effects.includes('energyBloom')) { colorPass(`blur(${Math.max(3, width * 0.06)}px) saturate(4) brightness(1.35) hue-rotate(${phase * 55}deg)`, translucent(0.13), 'screen'); colorPass(`contrast(2.2) saturate(3.2) hue-rotate(${phase * -90}deg)`, translucent(0.08), 'lighter'); }
  if (effects.includes('liquidChromatic')) { colorPass(`blur(${Math.max(1, width * 0.018)}px) hue-rotate(${phase * 120}deg) saturate(4)`, translucent(0.14), 'overlay'); colorPass(`hue-rotate(${180 - phase * 90}deg) saturate(3.5) contrast(1.6)`, translucent(0.08), 'screen'); }
  if (effects.includes('kaleido')) {
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = translucent(0.1); ctx.filter = `saturate(2.8) contrast(1.45) hue-rotate(${phase * 50}deg)`; ctx.translate(cx, cy); ctx.rotate(Math.sin(phase) * 0.18);
    for (let i = 0; i < 6; i += 1) { ctx.rotate(Math.PI / 3); ctx.fillStyle = palette[i % 3]; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(width * 0.7, height * 0.12); ctx.lineTo(width * 0.18, height * 0.62); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
  if (effects.includes('invertCascade')) { colorPass(`invert(1) hue-rotate(${phase * 110}deg) saturate(2.5) contrast(1.7)`, translucent(0.13), 'difference'); colorPass(`invert(1) blur(${Math.max(1, width * 0.01)}px) hue-rotate(${180 - phase * 65}deg)`, translucent(0.08), 'exclusion'); }
  ctx.restore();
};

function useCanvasDrawing(canvasRef: RefObject<HTMLCanvasElement>, overlay: OverlaySnapshot, source: SourceSnapshot, mirror: boolean, visualConfig: OverlayVisualConfig, videoRef: RefObject<HTMLVideoElement>) {
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
      regions.forEach((region, index) => drawStyledRegionEffects(ctx, region.corners, visualConfig.effects, index, overlay.sourceTime ?? 0, videoRef.current ?? undefined, width, height, mirror));
      if (visualConfig.connections.includes('portal')) {
        const corners = ['hand_1:thumb', 'hand_1:index', 'hand_2:index', 'hand_2:thumb'].map(get).filter((p): p is { x: number; y: number } => Boolean(p));
        if (corners.length === 4) corners.forEach((point, index) => drawConnection(ctx, point, corners[(index + 1) % corners.length], 'portal'));
      }
      if (visualConfig.connections.includes('fingers')) overlay.hands.forEach((hand) => { const points = FINGER_ORDER.map((finger) => get(`${hand.side}:${finger}`)).filter((p): p is { x: number; y: number } => Boolean(p)); points.forEach((point, index) => { if (index) drawConnection(ctx, points[index - 1], point, 'fingers'); }); });
      if (visualConfig.connections.includes('bridges')) FINGER_ORDER.forEach((finger) => { const left = get(`hand_1:${finger}`); const right = get(`hand_2:${finger}`); if (left && right) drawConnection(ctx, left, right, 'bridges'); });
      if (visualConfig.connections.includes('mesh')) { const points = [...positions.values()]; points.forEach((p, i) => points.slice(i + 1).forEach((other) => drawConnection(ctx, p, other, 'mesh'))); }
      if (visualConfig.connections.includes('fine')) { const points = [...positions.values()]; points.forEach((point, index) => points.slice(index + 1).forEach((other) => drawConnection(ctx, point, other, 'fine'))); }
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
  }, [canvasRef, mirror, overlay, source, visualConfig, videoRef]);
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
  useCanvasDrawing(canvasRef, overlay, source, mirror, visualConfig, videoRef);

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
          <div className="visual-controls-title">{language === 'zh' ? '连接线样式（可多选）' : 'Connection styles (multi-select)'}</div>
          <div className="visual-options">{([['portal', language === 'zh' ? '门户外框' : 'Portal frame'], ['fingers', language === 'zh' ? '手指链' : 'Finger chains'], ['bridges', language === 'zh' ? '同名桥接' : 'Matching bridges'], ['mesh', language === 'zh' ? '全连接网格' : 'Complete mesh'], ['fine', language === 'zh' ? '极简细线' : 'Minimal fine lines']] as [ConnectionStyle, string][]).map(([value, label]) => <label key={value}><input type="checkbox" checked={visualConfig.connections.includes(value)} onChange={() => onVisualConfigChange('connections', value)} /><span>{label}</span></label>)}</div>
          <div className="visual-controls-title">{language === 'zh' ? '复杂矩形内部色变（可多选）' : 'Complex full-region color treatments (multi-select)'}</div>
          <div className="visual-options">{([['aurora', language === 'zh' ? '极光色场' : 'Aurora field'], ['prismatic', language === 'zh' ? '棱镜流变' : 'Prismatic flow'], ['invertCascade', language === 'zh' ? '级联反转' : 'Inversion cascade'], ['comicInk', language === 'zh' ? '漫画墨线' : 'Comic ink'], ['thermal', language === 'zh' ? '热成像' : 'Thermal'], ['posterInvert', language === 'zh' ? '海报反转' : 'Poster invert'], ['noirGraphic', language === 'zh' ? '图形黑白' : 'Graphic noir'], ['channelShift', language === 'zh' ? 'RGB 分离' : 'RGB split'], ['kaleido', language === 'zh' ? '万花镜变换' : 'Kaleidoscope'], ['liquidChromatic', language === 'zh' ? '液态色差' : 'Liquid chromatic'], ['energyBloom', language === 'zh' ? '能量绽放' : 'Energy bloom']] as [RegionEffect, string][]).map(([value, label]) => <label key={value}><input type="checkbox" checked={visualConfig.effects.includes(value)} onChange={() => onVisualConfigChange('effects', value)} /><span>{label}</span></label>)}</div>
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
