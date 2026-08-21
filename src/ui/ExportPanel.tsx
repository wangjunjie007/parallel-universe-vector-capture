import { Archive, Download, FileArchive, Film, LockKeyhole, Route } from 'lucide-react';
import type { ExportSnapshot, Language } from './types';
import { formatBytes } from './format';
import { t } from './i18n';

interface ExportPanelProps {
  language: Language;
  exportState: ExportSnapshot;
  onStandard: () => void | Promise<void>;
  onDiagnostics: () => void | Promise<void>;
  onJianying?: () => void | Promise<void>;
  jianyingReady?: boolean;
  onEffectVideo?: () => void | Promise<void>;
  effectVideoReady?: boolean;
  effectVideoBusy?: boolean;
}

export function ExportPanel({ language, exportState, onStandard, onDiagnostics, onJianying, jianyingReady = false, onEffectVideo, effectVideoReady = false, effectVideoBusy = false }: ExportPanelProps) {
  const ready = exportState.quality === 'ready' || exportState.quality === 'needs_review';
  return (
    <section className="export-panel" aria-labelledby="export-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker">04 / PACKAGE</span>
          <h2 id="export-title">{t(language, 'export')}</h2>
        </div>
        <LockKeyhole size={15} aria-label={t(language, 'localOnly')} />
      </div>
      <p className="export-note">{ready ? `${exportState.fileName ?? 'vector-capture'}.zip · ${formatBytes(exportState.sizeBytes)}` : t(language, 'notReady')}</p>
      <div className="export-actions">
        <button type="button" className="export-button primary" onClick={onStandard} disabled={!exportState.standardReady}>
          <Archive size={16} aria-hidden="true" />
          <span><strong>{t(language, 'standard')}</strong><small>{t(language, 'packageContents')}</small></span>
          <Download size={15} aria-hidden="true" />
        </button>
        <button type="button" className="export-button" onClick={onDiagnostics} disabled={!exportState.diagnosticsReady}>
          <FileArchive size={16} aria-hidden="true" />
          <span><strong>{t(language, 'diagnostics')}</strong><small>raw · quality · diagnostics</small></span>
          <Download size={15} aria-hidden="true" />
        </button>
        <button type="button" className="export-button" onClick={onJianying} disabled={!jianyingReady || !onJianying}>
          <Route size={16} aria-hidden="true" />
          <span><strong>{language === 'zh' ? '下载剪映关键帧包' : 'Download Jianying keyframes'}</strong><small>{language === 'zh' ? 'ZIP · 手指独立轨道 · JSON/CSV' : 'ZIP · one finger track · JSON/CSV'}</small></span>
          <Download size={15} aria-hidden="true" />
        </button>
        <button type="button" className="export-button effect-video-button" onClick={onEffectVideo} disabled={!effectVideoReady || effectVideoBusy}>
          {effectVideoBusy ? <Film className="spin" size={16} aria-hidden="true" /> : <Film size={16} aria-hidden="true" />}
          <span><strong>{language === 'zh' ? '下载特效成品视频' : 'Download effect video'}</strong><small>{language === 'zh' ? 'WebM · 保留音频，移除帧点与连线' : 'WebM · audio kept, points and lines removed'}</small></span>
          <Download size={15} aria-hidden="true" />
        </button>
      </div>
      <p className="export-note">{language === 'zh' ? '剪映转换包，不是剪映原生草稿文件' : 'Conversion package, not a native Jianying draft'}</p>
      {exportState.quality === 'needs_review' ? <div className="export-review-flag">{language === 'zh' ? '包内已保留 needs_review 标记' : 'needs_review flags are retained in the package'}</div> : null}
    </section>
  );
}
