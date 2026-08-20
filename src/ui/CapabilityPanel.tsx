import {
  Camera,
  Check,
  CircleHelp,
  Cpu,
  RefreshCw,
  ShieldCheck,
  TimerReset,
  Workflow,
  X,
} from 'lucide-react';
import type { CapabilityCheck, CapabilitySnapshot, Language } from './types';
import { t } from './i18n';

interface CapabilityPanelProps {
  language: Language;
  capabilities: CapabilitySnapshot;
  onCheck: () => void | Promise<void>;
}

const items = [
  { key: 'secureContext', icon: ShieldCheck, label: 'secureContext' },
  { key: 'camera', icon: Camera, label: 'camera' },
  { key: 'workers', icon: Workflow, label: 'workers' },
  { key: 'wasm', icon: Cpu, label: 'wasm' },
  { key: 'videoFrameCallback', icon: TimerReset, label: 'videoFrameCallback' },
] as const;

const stateIcon = (state: CapabilityCheck['state']) => {
  if (state === 'available') return Check;
  if (state === 'unavailable') return X;
  return CircleHelp;
};

export function CapabilityPanel({ language, capabilities, onCheck }: CapabilityPanelProps) {
  const checks = items.map((item) => capabilities[item.key]);
  const allReady = checks.every((check) => check.state === 'available');

  return (
    <section className="capability-panel" aria-labelledby="capability-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">00 / SYSTEM</span>
          <h2 id="capability-title">{t(language, 'capability')}</h2>
        </div>
        <button className="icon-button quiet" type="button" onClick={onCheck} title={t(language, 'checkAgain')} aria-label={t(language, 'checkAgain')}>
          <RefreshCw size={16} strokeWidth={1.8} />
        </button>
      </div>
      <div className={`capability-summary ${allReady ? 'is-ready' : 'has-attention'}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <span>{allReady ? t(language, 'capabilityReady') : t(language, 'capabilityAttention')}</span>
        <span className="summary-rule" aria-hidden="true" />
        <span className="summary-note">{t(language, 'permissionHint')}</span>
      </div>
      <ul className="capability-list">
        {items.map((item) => {
          const check = capabilities[item.key];
          const ItemIcon = item.icon;
          const StateIcon = stateIcon(check.state);
          const label = t(language, item.label);
          const stateLabel = t(language, check.state);
          return (
            <li className="capability-row" key={item.key}>
              <span className="capability-icon" aria-hidden="true"><ItemIcon size={15} strokeWidth={1.8} /></span>
              <span className="capability-name">{label}</span>
              <span className={`capability-state state-${check.state}`}>
                <StateIcon size={13} strokeWidth={2} aria-hidden="true" />
                <span>{stateLabel}</span>
              </span>
              {check.detail ? <span className="capability-detail">{check.detail}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
