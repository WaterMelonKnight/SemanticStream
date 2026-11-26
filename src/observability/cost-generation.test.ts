import { describe, expect, it } from 'vitest';
import { CostGeneration } from './cost-generation';

describe('cost generation', () => {
  it('invalidates a late result after a session switch or pagehide', () => {
    const generation = new CostGeneration();
    const request = generation.current();
    expect(generation.isCurrent(request)).toBe(true);
    generation.next();
    expect(generation.isCurrent(request)).toBe(false);
    const restored = generation.next();
    expect(generation.isCurrent(restored)).toBe(true);
    generation.next();
    expect(generation.isCurrent(restored)).toBe(false);
  });
});
