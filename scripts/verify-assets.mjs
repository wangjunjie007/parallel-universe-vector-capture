import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(await readFile(resolve(root, 'public/wasm/manifest.json'), 'utf8'));
const checks = [];
for (const [name, expected] of Object.entries(manifest.wasm ?? {})) {
  const bytes = await readFile(resolve(root, 'public/wasm', name));
  const actual = createHash('sha256').update(bytes).digest('hex');
  checks.push({ name, ok: actual === expected, expected, actual });
}
const modelBytes = await readFile(resolve(root, 'public/models/hand_landmarker.task'));
const modelActual = createHash('sha256').update(modelBytes).digest('hex');
const modelExpected = manifest.model?.sha256;
checks.push({
  name: 'hand_landmarker.task',
  ok: modelBytes.byteLength > 100_000 && (!modelExpected || modelActual === modelExpected),
  bytes: modelBytes.byteLength,
  expected: modelExpected,
  actual: modelActual,
});
console.table(checks);
if (checks.some((check) => !check.ok)) process.exit(1);
