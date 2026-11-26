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

  it('defines two independent complete CSP blocks for clean and .html perception paths', async () => {
    const headers = await readFile('public/_headers', 'utf8');
    const lines = headers.split('\n');
    const findRule = (path: string): string[] | undefined => {
      const index = lines.indexOf(path);
      if (index < 0) return undefined;
      const rule: string[] = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() === '' || line.startsWith('#')) break;
        if (!line.startsWith('  ')) break;
        rule.push(line.trim());
      }
      return rule;
    };
    const clean = findRule('/perception');
    const html = findRule('/perception.html');
    for (const rule of [clean, html]) {
      expect(rule).toBeDefined();
      expect(rule).toHaveLength(1);
      expect(rule![0]).toMatch(/^Content-Security-Policy: /);
      expect(rule![0]).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(rule![0]).toContain("worker-src 'self' blob:");
      expect(rule![0]).toContain('https://storage.googleapis.com');
    }
    expect(headers).not.toContain('Content-Type: application/wasm');
    expect(findRule('/runtime.html')).toBeUndefined();
  });
});
