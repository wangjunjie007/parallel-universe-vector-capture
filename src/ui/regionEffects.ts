import { buildEffectRegions, type OverlayPosition } from './overlayGeometry';

export type RegionEffect = 'aurora' | 'prismatic' | 'invertCascade' | 'kaleido' | 'liquidChromatic' | 'energyBloom';

const palettes = [
  ['#46d9a0', '#c6a7ff', '#ff9d83'],
  ['#8bd3dd', '#ffd166', '#ff7a90'],
  ['#c6a7ff', '#46d9a0', '#8bd3dd'],
] as const;

function polygon(ctx: CanvasRenderingContext2D, corners: OverlayPosition[]): void {
  ctx.beginPath();
  corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath();
}

/** Paints only the clipped portal faces. No points, labels, trails, or edges are drawn here. */
export function drawRegionEffects(ctx: CanvasRenderingContext2D, corners: OverlayPosition[], effects: RegionEffect[], regionIndex: number, time: number): void {
  if (corners.length !== 4 || effects.length === 0) return;
  const xs = corners.map((point) => point.x); const ys = corners.map((point) => point.y);
  const left = Math.min(...xs); const top = Math.min(...ys); const width = Math.max(1, Math.max(...xs) - left); const height = Math.max(1, Math.max(...ys) - top);
  const palette = palettes[regionIndex % palettes.length];
  const phase = time * 1.7 + regionIndex * 1.31;
  const veil = Math.min(0.34, 0.3 / Math.max(1, effects.length * 0.62));
  ctx.save(); polygon(ctx, corners); ctx.clip();
  const field = ctx.createLinearGradient(left + Math.cos(phase) * width, top - height, left + width, top + Math.sin(phase) * height);
  field.addColorStop(0, palette[0]); field.addColorStop(0.38, palette[1]); field.addColorStop(0.72, palette[2]); field.addColorStop(1, '#071013');
  ctx.globalAlpha = veil; ctx.fillStyle = field; ctx.fillRect(left, top, width, height);
  const pass = (filter: string, alpha: number, mode: GlobalCompositeOperation = 'screen') => {
    ctx.save(); ctx.globalCompositeOperation = mode; ctx.globalAlpha = alpha; ctx.filter = filter;
    const gradient = ctx.createLinearGradient(left + Math.sin(phase * 1.3) * width, top + height, left + width, top - Math.cos(phase) * height);
    gradient.addColorStop(0, palette[0]); gradient.addColorStop(0.45, palette[1]); gradient.addColorStop(1, palette[2]);
    ctx.fillStyle = gradient; ctx.fillRect(left - width * 0.2, top - height * 0.2, width * 1.4, height * 1.4); ctx.restore();
  };
  if (effects.includes('aurora')) pass(`hue-rotate(${Math.sin(phase) * 90}deg) saturate(3) contrast(1.25)`, veil * 0.78);
  if (effects.includes('prismatic')) pass(`hue-rotate(${phase * 70}deg) saturate(4) contrast(1.45)`, veil * 0.75, 'screen');
  if (effects.includes('liquidChromatic')) pass(`blur(${Math.max(1, width * 0.02)}px) hue-rotate(${phase * 120}deg) saturate(4)`, veil * 0.72, 'overlay');
  if (effects.includes('energyBloom')) pass(`blur(${Math.max(3, width * 0.07)}px) saturate(4) brightness(1.4) hue-rotate(${phase * 55}deg)`, veil * 0.65, 'screen');
  if (effects.includes('invertCascade')) pass(`invert(1) hue-rotate(${phase * 110}deg) saturate(2.5) contrast(1.5)`, veil * 0.7, 'difference');
  if (effects.includes('kaleido')) {
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = veil * 0.6; ctx.translate(left + width / 2, top + height / 2); ctx.rotate(Math.sin(phase) * 0.16);
    for (let index = 0; index < 6; index += 1) { ctx.rotate(Math.PI / 3); ctx.fillStyle = palette[index % 3]; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(width * 0.8, height * 0.1); ctx.lineTo(width * 0.25, height * 0.7); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
  ctx.restore();
}

export function drawSemanticEffects(ctx: CanvasRenderingContext2D, points: ReadonlyArray<{ side: 'hand_1' | 'hand_2'; finger: 'thumb' | 'index' | 'middle' | 'ring' | 'little'; x: number; y: number }>, width: number, height: number, effects: RegionEffect[], time: number): void {
  const positions = new Map<string, OverlayPosition>();
  points.forEach((point) => positions.set(`${point.side}:${point.finger}`, { x: point.x, y: point.y }));
  const regions = buildEffectRegions(positions, true, points.length >= 8);
  regions.forEach((region, index) => drawRegionEffects(ctx, region.corners, effects, index, time));
}
