import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve('node_modules/@mediapipe/tasks-vision');
const version = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version;
const source = resolve(packageRoot, 'wasm');
const destination = resolve('public/mediapipe/wasm', version);
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
console.log(`Prepared self-hosted MediaPipe Wasm assets in public/mediapipe/wasm/${version}.`);
