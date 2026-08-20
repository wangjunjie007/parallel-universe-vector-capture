import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'parallel-universe-vector-capture';
const isPages = process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  base: isPages ? `/${repository}/` : '/',
  plugins: [
    {
      name: 'mediapipe-module-loader-dev',
      enforce: 'pre',
      async load(id) {
        // MediaPipe dynamically imports this self-hosted ESM loader from its
        // module Worker. Vite normally rejects JS imports from public/ in dev;
        // serving this one pinned file keeps development identical to Pages.
        if (id.split('?')[0] === '/wasm/vision_wasm_module_internal.js') {
          return readFile(resolve('public/wasm/vision_wasm_module_internal.js'), 'utf8');
        }
        return null;
      },
    },
    react(),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 4096,
  },
});
