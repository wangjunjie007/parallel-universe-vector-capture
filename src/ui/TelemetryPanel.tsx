import { Activity, Gauge, Layers3, Timer, TrendingDown } from 'lucide-react';
import type { CaptureMode, Language, MetricsSnapshot, SourceSnapshot } from './types';
import { formatNumber } from './format';
import { t } from './i18n';

interface TelemetryPanelProps {
  language: Language;
  metrics: MetricsSnapshot;
  source: SourceSnapshot;
  mode: CaptureMode;
}

export function TelemetryPanel({ language, metrics, source, mode }: TelemetryPanelProps) {
  const alignment = metrics.alignment === 'exact_source_frames' ? t(language, 'exact') : metrics.alignment === 'presentation_time_estimate' ? t(language, 'estimate') : t(language, 'unknownValue');
  return (
    <section className="telemetry-panel" aria-labelledby="telemetry-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker">02 / SIGNAL</span>
          <h2 id="telemetry-title">{t(language, 'telemetry')}</h2>
        </div>
        <span className={`mode-badge mode-${mode}`}>{mode === 'live' ? t(language, 'liveShort') : t(language, 'preciseShort')}</span>
      </div>
      <div className="telemetry-grid">
        <Metric icon={<Gauge size={14} />} label={t(language, 'fps')} value={metrics.actualFps === undefined ? '—' : formatNumber(metrics.actualFps, 1)} unit="fps" />
        <Metric icon={<Timer size={14} />} label={t(language, 'inference')} value={metrics.inferenceMs === undefined ? '—' : formatNumber(metrics.inferenceMs, 0)} unit="ms" />
        <Metric icon={<TrendingDown size={14} />} label={t(language, 'dropped')} value={String(metrics.droppedFrames)} unit="frames" tone={metrics.droppedFrames > 0 ? 'warning' : 'normal'} />
        <Metric icon={<Layers3 size={14} />} label={t(language, 'frames')} value={String(metrics.processedFrames)} unit={metrics.totalFrames ? `/ ${metrics.totalFrames}` : 'frames'} />
      </div>
      <div className="alignment-row">
        <Activity size={14} aria-hidden="true" />
        <span>{t(language, 'alignment')}</span>
        <strong>{alignment}</strong>
      </div>
      <dl className="source-specs">
        <div><dt>{t(language, 'source')}</dt><dd>{source.name ?? (source.kind === 'camera' ? t(language, 'sourceCamera') : source.kind === 'file' ? t(language, 'sourceFile') : '—')}</dd></div>
        <div><dt>{t(language, 'dimensions')}</dt><dd>{source.width > 0 ? `${source.width} × ${source.height}` : '—'}</dd></div>
        <div><dt>{t(language, 'orientation')}</dt><dd>{source.orientationLabel ?? `${source.rotation}°`}</dd></div>
        <div><dt>{t(language, 'mirrored')}</dt><dd>{source.mirrored ? t(language, 'yes') : t(language, 'no')}</dd></div>
      </dl>
    </section>
  );
}

function Metric({ icon, label, value, unit, tone = 'normal' }: { icon: React.ReactNode; label: string; value: string; unit: string; tone?: 'normal' | 'warning' }) {
  return (
    <div className={`metric-cell tone-${tone}`}>
      <div className="metric-label">{icon}<span>{label}</span></div>
      <div className="metric-value"><strong>{value}</strong><small>{unit}</small></div>
    </div>
  );
}
