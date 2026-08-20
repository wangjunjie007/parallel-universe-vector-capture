import { LockKeyhole, X } from 'lucide-react';
import type { Language } from './types';
import { t } from './i18n';

interface PrivacyDialogProps {
  language: Language;
  open: boolean;
  onClose: () => void;
}

export function PrivacyDialog({ language, open, onClose }: PrivacyDialogProps) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
        <div className="dialog-header">
          <div className="dialog-title"><LockKeyhole size={18} /><h2 id="privacy-title">{t(language, 'privacyTitle')}</h2></div>
          <button className="icon-button quiet" type="button" onClick={onClose} aria-label={t(language, 'close')} title={t(language, 'close')}><X size={17} /></button>
        </div>
        <p>{t(language, 'privacyBody')}</p>
        <div className="privacy-facts">
          <span><b>01</b>{language === 'zh' ? '不上传视频' : 'No video upload'}</span>
          <span><b>02</b>{language === 'zh' ? '不保存账号' : 'No account storage'}</span>
          <span><b>03</b>{language === 'zh' ? '离开页面即释放会话' : 'Session clears on exit'}</span>
        </div>
        <button className="text-button" type="button" onClick={onClose}>{t(language, 'close')}</button>
      </section>
    </div>
  );
}
