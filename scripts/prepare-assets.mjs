import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(root, 'node_modules/@mediapipe/tasks-vision');
const wasmRoot = resolve(packageRoot, 'wasm');
const manifestPath = resolve(root, 'public/wasm/manifest.json');
const modelPath = resolve(root, 'public/models/hand_landmarker.task');
const modelPartsRoot = resolve(root, 'assets/model');
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

const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
if (packageJson.version !== expected.mediapipe_tasks_vision) {
  throw new Error(
    `MediaPipe version mismatch: expected ${expected.mediapipe_tasks_vision}, got ${packageJson.version}`,
  );
}

const partNames = (await readdir(modelPartsRoot))
  .filter((name) => /^hand_landmarker\.task\.part-\d{3}$/.test(name))
  .sort();
if (partNames.length === 0) {
  throw new Error('No hand landmarker model parts found');
}

await mkdir(resolve(root, 'public/models'), { recursive: true });
const modelParts = await Promise.all(
  partNames.map((name) => readFile(resolve(modelPartsRoot, name))),
);
await writeFile(modelPath, Buffer.concat(modelParts));

await mkdir(resolve(root, 'public/wasm'), { recursive: true });
for (const [name, source] of assets) {
  await copyFile(source, resolve(root, 'public/wasm', name));
}

const hash = async (path) => {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
};
const actualModelHash = await hash(modelPath);
if (actualModelHash !== expected.model.sha256) {
  throw new Error(`Model SHA-256 mismatch: expected ${expected.model.sha256}, got ${actualModelHash}`);
}

for (const [name] of assets) {
  const actual = await hash(resolve(root, 'public/wasm', name));
  const expectedHash = expected.wasm[name];
  if (actual !== expectedHash) {
    throw new Error(`${name} SHA-256 mismatch: expected ${expectedHash}, got ${actual}`);
  }
}

console.log(`Prepared verified model and ${assets.length} MediaPipe WASM assets`);
