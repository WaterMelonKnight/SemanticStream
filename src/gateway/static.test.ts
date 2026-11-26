import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localGateway } from './fixtures';
import { contentSecurityPolicyFor, mediaTypeFor, staticFileAllowed } from './server';

describe('gateway static security policy', () => {
  it('allows the three pages, Vite assets, benchmark data, and the exact MediaPipe module wasm', () => {
    for (const name of [
      'index.html', 'runtime.html', 'perception.html', 'favicon.png',
      'assets/index-abc123.js', 'assets/perception-abc123.css', 'benchmark/latest.json',
      'mediapipe/wasm/1.2.3/vision_wasm_module_internal.js',
      'mediapipe/wasm/1.2.3/vision_wasm_module_internal.wasm',
    ]) expect(staticFileAllowed(name), name).toBe(true);
  });

  it('does not allow model weights or arbitrary paths', () => {
    for (const name of [
      'models/efficientdet_lite0.tflite', '../perception.html', 'mediapipe/wasm/other.wasm',
      'mediapipe/wasm/vision_wasm_internal.wasm', 'src/perception.ts', 'assets/../runtime.html',
    ]) expect(staticFileAllowed(name), name).toBe(false);
  });

  it('serves Wasm with the registered MIME type', () => {
    expect(mediaTypeFor('mediapipe/wasm/1.2.3/vision_wasm_module_internal.wasm')).toBe('application/wasm');
    expect(mediaTypeFor('perception.html')).toBe('text/html; charset=utf-8');
    expect(mediaTypeFor('models/efficientdet_lite0.tflite')).toBeUndefined();
  });

  it('keeps the runtime/index CSP strict and adds only the perception worker/wasm/model origins', () => {
    const runtime = contentSecurityPolicyFor('runtime.html');
    const perception = contentSecurityPolicyFor('perception.html');
    expect(runtime).not.toContain('wasm-unsafe-eval');
    expect(runtime).not.toContain('storage.googleapis.com');
    expect(perception).toContain("'wasm-unsafe-eval'");
    expect(perception).toContain("worker-src 'self' blob:");
    expect(perception).toContain('https://storage.googleapis.com');
    expect(perception).toContain("frame-ancestors 'none'");
  });
});

describe('gateway perception static route', () => {
  it('serves perception and module wasm with page-specific CSP, while refusing model weights', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'semanticstream-static-'));
    await mkdir(join(dist, 'mediapipe', 'wasm', '1.2.3'), { recursive: true });
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'perception.html'), '<!doctype html><title>perception</title>');
    await writeFile(join(dist, 'assets', 'detector.worker-test.js'), 'self.onmessage = () => {};');
    await writeFile(join(dist, 'mediapipe', 'wasm', '1.2.3', 'vision_wasm_module_internal.wasm'), new Uint8Array([0, 97, 115, 109]));
    const fixture = await localGateway(undefined, { dist });
    try {
      const page = await fetch(fixture.origin + '/perception.html');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'");
      expect(page.headers.get('content-security-policy')).toContain('https://storage.googleapis.com');
      const wasm = await fetch(fixture.origin + '/mediapipe/wasm/1.2.3/vision_wasm_module_internal.wasm');
      expect(wasm.status).toBe(200);
      expect(wasm.headers.get('content-type')).toBe('application/wasm');
      const worker = await fetch(fixture.origin + '/assets/detector.worker-test.js');
      expect(worker.status).toBe(200);
      expect(worker.headers.get('content-security-policy')).toBeNull();
      const model = await fetch(fixture.origin + '/models/efficientdet_lite0.tflite');
      expect(model.status).toBe(404);
    } finally {
      await fixture.close();
      await rm(dist, { recursive: true, force: true });
    }
  }, 15_000);
});
