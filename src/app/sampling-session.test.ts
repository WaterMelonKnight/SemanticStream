import { describe, expect, it } from 'vitest';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import { DecisionEngine } from '../decision/engine';
import type { ScheduledDecision } from '../decision/engine';
import type { DecisionAction, DecisionProvider, DecisionProviderResult, DecisionState, TaskDefinition } from '../decision/types';
import { SamplingSession } from './sampling-session';

function proposal(action: DecisionAction): DecisionProviderResult {
  const reason = 'Controlled test provider.';
  return { action, scoreKind: 'heuristic', reason, candidates: [{ action, reason, score: 0.5, priority: 1 }] };
}

function setup() {
  const calls: Array<{
    state: DecisionState;
    signal?: AbortSignal;
    resolve: (result: DecisionProviderResult) => void;
  }> = [];
  const primary: DecisionProvider = {
    id: 'controlled',
    scoreKind: 'heuristic',
    decide: (state, signal) => new Promise((resolve) => calls.push({ state, signal, resolve })),
  };
  const fallback: DecisionProvider = { id: 'fallback', scoreKind: 'heuristic', decide: () => proposal('WAIT') };
  const clock = { now: 0 };
  const now = () => clock.now;
  const engine = new DecisionEngine(primary, fallback, { now, timeoutMs: 100 });
  const task: TaskDefinition = {
    id: 'same-id', label: 'Read the panel', category: 'text-reading', priority: 'high',
    roi: { x: 0, y: 0, width: 2, height: 2 },
  };

  function create(id: string) {
    const rendered: ScheduledDecision[] = [];
    const sink = { accept: () => true };
    const session = new SamplingSession(id, { adaptive: sink, fixed: sink }, {
      threshold: 1.5, budget: 3, adaptiveStrategy: 'task', localThreshold: 2.5,
      blockWidth: 8, blockHeight: 8, task,
    }, engine, (result) => rendered.push(result), now);
    function input(sequence: number, timestampMs: number, pixel = 0) {
      clock.now = timestampMs;
      const sample = new Uint8ClampedArray(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4).fill(pixel);
      return session.process({ sequence, timestampMs, payload: null }, sample);
    }
    return { session, rendered, input };
  }
  return { calls, task, create };
}

describe('visual session runtime without DOM', () => {
  it('isolates an abandoned source and its decision from the new session', async () => {
    const { calls, create } = setup();
    const first = create('video-before-seek');
    const old = first.input(1, 10);
    expect(calls[0].state.cache.availableRange).toEqual({ startMs: 10, endMs: 10 });
    first.session.dispose();

    const second = create('video-after-seek');
    const current = second.input(1, 20, 42);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(await old.decision).toBeNull();
    expect(first.session.retrieveFrame(1).status).toBe('disposed');
    calls[1].resolve(proposal('WAIT'));
    expect(await current.decision).toMatchObject({ action: 'WAIT', sessionId: 'video-after-seek' });
    calls[0].resolve(proposal('SEND_FRAME'));
    expect(first.rendered).toHaveLength(0);
    expect(second.rendered.map(({ action }) => action)).toEqual(['WAIT']);
    expect(second.session.retrieveFrame(1).frame?.pixels[0]).toBe(42);
  });

  it('invalidates a pending decision immediately on an ROI edit with the same task ID', async () => {
    const { calls, task, create } = setup();
    const { input, session, rendered } = create('demo');
    const old = input(1, 0);
    session.setTask({ ...task, roi: { x: 10, y: 10, width: 2, height: 2 } });
    const next = input(2, 10);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].state.task.roi?.x).toBe(10);
    calls[0].resolve(proposal('SEND_FRAME'));
    expect(await old.decision).toBeNull();
    expect(await input(3, 20).decision).toBeNull();
    expect(calls).toHaveLength(2);
    calls[1].resolve(proposal('DROP'));
    expect(await next.decision).toMatchObject({ action: 'DROP', requestId: 2, observationVersion: 2 });
    expect(rendered.map(({ action }) => action)).toEqual(['DROP']);
  });

  it('applies a fresh send once, preserves fixed sampling, and charges manual retrieval separately', async () => {
    const { calls, create } = setup();
    const { input, session } = create('demo');
    const first = input(1, 0);
    expect(first.decisions).toEqual({ adaptive: 'sent', fixed: 'sent' });
    calls[0].resolve(proposal('SEND_PREVIEW'));
    await first.decision;
    const next = input(2, 125, 100);
    expect(next.decisions).toEqual({ adaptive: 'sent', fixed: 'policy' });
    calls[1].resolve(proposal('WAIT'));
    await next.decision;
    const later = input(3, 250, 100);
    expect(later.decisions).toEqual({ adaptive: 'policy', fixed: 'sent' });
    calls[2].resolve(proposal('WAIT'));
    await later.decision;

    const crop = session.retrieveRegion(2, { x: 0, y: 0, width: 1, height: 1 });
    expect(crop).toMatchObject({ status: 'available', bytes: 4, sourceFrame: { timestampMs: 125 }, deliveredAtMs: 250 });
    expect(crop.image?.pixels[0]).toBe(100);
    expect(session.evidence().retrieval.budget).toMatchObject({
      realtime: { usedFrames: 2 }, retrieval: { usedFrames: 1 }, total: { usedFrames: 3 },
    });
    expect(session.timeline.toArray().map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
  });
});
