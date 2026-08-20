import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from 'lucide-react';
import type { DiagnosticItem, Language } from './types';
import { t } from './i18n';

interface DiagnosticsPanelProps {
  language: Language;
  diagnostics: DiagnosticItem[];
}

const SeverityIcon = ({ severity }: { severity: DiagnosticItem['severity'] }) => {
  if (severity === 'error') return <ShieldAlert size={15} />;
  if (severity === 'warning') return <AlertTriangle size={15} />;
  return <Info size={15} />;
};

export function DiagnosticsPanel({ language, diagnostics }: DiagnosticsPanelProps) {
  const visible = diagnostics.filter((item) => !item.acknowledged).slice(0, 4);
  return (
    <section className="diagnostics-panel" aria-labelledby="diagnostics-title">
      <div className="section-heading compact">
        <div>
          <span className="section-kicker">03 / REVIEW</span>
          <h2 id="diagnostics-title">{t(language, 'quality')}</h2>
        </div>
        {visible.length === 0 ? <CheckCircle2 className="quality-good" size={17} aria-label={t(language, 'noWarnings')} /> : <span className="diagnostic-count">{visible.length}</span>}
      </div>
      {visible.length === 0 ? (
        <p className="empty-diagnostics">{t(language, 'noWarnings')}</p>
      ) : (
        <ul className="diagnostic-list" aria-live="polite">
          {visible.map((item) => (
            <li className={`diagnostic-item severity-${item.severity}`} key={item.id}>
              <span className="diagnostic-icon" aria-hidden="true"><SeverityIcon severity={item.severity} /></span>
              <span><strong>{item.title}</strong>{item.detail ? <small>{item.detail}</small> : null}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
