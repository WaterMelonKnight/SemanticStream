import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MEDIAPIPE_RUNTIME_VERSION } from '../perception/types';

describe('Cloudflare Pages headers', () => {
  it('keeps versioned immutable caching without overriding MIME types', async () => {
    const headers = await readFile('public/_headers', 'utf8');
    expect(headers).toContain(`/mediapipe/wasm/${MEDIAPIPE_RUNTIME_VERSION}/*`);
    expect(headers).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(headers).not.toContain('Content-Type: application/wasm');
    expect(headers).not.toMatch(/\/mediapipe\/wasm\/\*[\s\S]*Content-Type/);
  });

  it('applies the perception CSP to both the clean and .html paths without loosening other pages', async () => {
    const headers = await readFile('public/_headers', 'utf8');
    expect(headers).toContain('/perception\n/perception.html');
    expect(headers).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(headers).toContain("worker-src 'self' blob:");
    expect(headers).toContain('https://storage.googleapis.com');
    expect(headers).not.toContain('/runtime.html\n  Content-Security-Policy');
  });
});
