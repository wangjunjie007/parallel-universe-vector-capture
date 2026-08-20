import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const iconHref = `${import.meta.env.BASE_URL}favicon.svg`;
if (!document.head.querySelector('link[data-puc-favicon]')) {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.type = 'image/svg+xml';
  icon.href = iconHref;
  icon.dataset.pucFavicon = 'true';
  document.head.appendChild(icon);
}

const root = document.getElementById('root');

if (!root) throw new Error('Root element was not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
