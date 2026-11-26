import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve('node_modules/@mediapipe/tasks-vision/wasm');
const destination = resolve('public/mediapipe/wasm');
if (!existsSync(source)) {
  console.error('MediaPipe wasm files are missing. Run npm ci first.');
  process.exit(1);
}
mkdirSync(destination, { recursive: true });
for (const name of [
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
]) {
  cpSync(resolve(source, name), resolve(destination, name));
}
console.log('Prepared self-hosted MediaPipe Wasm assets in public/mediapipe/wasm.');
