import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(root, 'node_modules/@mediapipe/tasks-vision');
const wasmRoot = resolve(packageRoot, 'wasm');
const assets = [
  ['vision_wasm_internal.js', resolve(wasmRoot, 'vision_wasm_internal.js')],
  ['vision_wasm_internal.wasm', resolve(wasmRoot, 'vision_wasm_internal.wasm')],
  // Module workers need the ESM loader. Keep the classic loader above for
  // the main-thread fallback, which injects the loader with a script tag.
  ['vision_wasm_module_internal.js', resolve(wasmRoot, 'vision_wasm_module_internal.js')],
  ['vision_wasm_module_internal.wasm', resolve(wasmRoot, 'vision_wasm_module_internal.wasm')],
  ['vision_wasm_nosimd_internal.js', resolve(wasmRoot, 'vision_wasm_nosimd_internal.js')],
  ['vision_wasm_nosimd_internal.wasm', resolve(wasmRoot, 'vision_wasm_nosimd_internal.wasm')],
];

await mkdir(resolve(root, 'public/wasm'), { recursive: true });
for (const [name, source] of assets) {
  await copyFile(source, resolve(root, 'public/wasm', name));
}

const hash = async (path) => {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
};
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const modelPath = resolve(root, 'public/models/hand_landmarker.task');
const manifest = {
  mediapipe_tasks_vision: packageJson.version,
  model: {
    name: 'hand_landmarker.task',
    source: 'mediapipe hand_landmarker float16/1',
    sha256: await hash(modelPath),
  },
  wasm: Object.fromEntries(await Promise.all(assets.map(async ([name]) => [name, await hash(resolve(root, 'public/wasm', name))]))),
};
await writeFile(resolve(root, 'public/wasm/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared ${assets.length} MediaPipe WASM assets`);
