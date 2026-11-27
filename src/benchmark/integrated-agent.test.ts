import { expect, it } from 'vitest';
import { runIntegratedBenchmark } from './integrated-agent';

it('exercises one AgentSession end to end with bounded and deterministic outcomes', async () => {
  const original = await runIntegratedBenchmark();
  expect(await runIntegratedBenchmark()).toEqual(original);
  const [all, fifo, agent] = original.variants;
  expect(all.falsePositives).toBeGreaterThan(fifo.falsePositives);
  expect(agent.calls).toBeLessThan(all.calls);
  expect(agent.successes).toBeGreaterThan(fifo.successes);
  for (const variant of original.variants) expect(variant.violations).toBe(0);
  const find = (prefix: string) => agent.results.find((result) => result.scene.startsWith(prefix))!;
  expect(find('appearance').successes).toBe(3);
  expect(find('uncertain').observations).toEqual({ uncertain: true, policy: 'RETRIEVE', copies: 1 });
  expect(find('background').observations).toMatchObject({ oldEvidence: 'wrong-session', lateDecisions: 1 });
  expect(find('rolling evidence').observations).toEqual({ asOfSequence: 1, asOfCapture: 0, eventEvidence: 'evicted' });
  expect(find('insufficient').starts).toBe(0);
  expect(find('unconfirmed').held).toBe(2);
  expect(find('critical').staleBlocked).toBeGreaterThan(0);
});
