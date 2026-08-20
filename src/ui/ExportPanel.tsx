import { Archive, Download, FileArchive, LockKeyhole } from 'lucide-react';
import type { ExportSnapshot, Language } from './types';
import { formatBytes } from './format';
import { t } from './i18n';

interface ExportPanelProps {
  language: Language;
  exportState: ExportSnapshot;
  onStandard: () => void | Promise<void>;
  onDiagnostics: () => void | Promise<void>;
}

export function ExportPanel({ language, exportState, onStandard, onDiagnostics }: ExportPanelProps) {
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
      </div>
      {exportState.quality === 'needs_review' ? <div className="export-review-flag">{language === 'zh' ? '包内已保留 needs_review 标记' : 'needs_review flags are retained in the package'}</div> : null}
    </section>
  );
}
