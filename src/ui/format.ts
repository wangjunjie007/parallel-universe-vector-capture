import type { Language } from './types';

export const formatNumber = (value: number | undefined, digits = 1): string => {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
};

export const formatTime = (seconds: number | undefined, language: Language): string => {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  const value = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return language === 'zh' ? value : value;
};

export const formatBytes = (bytes: number | undefined): string => {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const formatPercent = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
};
