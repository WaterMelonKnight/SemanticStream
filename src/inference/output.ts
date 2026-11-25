import type { InferenceTask, OutputChannel, PartialOutput } from './types';

export interface OutputEntry {
  readonly taskId: number;
  readonly channel: OutputChannel;
  readonly text: string;
  readonly state: 'streaming' | 'completed' | 'stopped' | 'superseded';
}

const MAX_OUTPUT_CHARS = 2_048;
const OUTPUT_HISTORY = 16;

/** One writer per channel, with a monotonically advancing writer ID. */
export class OutputCoordinator {
  private readonly entries: OutputEntry[] = [];
  private readonly writers = new Map<OutputChannel, number>();

  partial(
    task: InferenceTask, chunk: PartialOutput, expectedIndex: number,
    active: boolean, session: number, interaction: number, nowMs: number,
  ): boolean {
    const writer = this.writers.get(task.channel) ?? 0;
    if (!active || task.sessionVersion !== session || task.interactionVersion !== interaction
      || nowMs >= task.deadlineMs || task.id < writer || chunk.index !== expectedIndex
      || typeof chunk.text !== 'string' || chunk.text.length === 0) return false;

    const index = this.entries.findIndex(({ taskId }) => taskId === task.id);
    const previous = this.entries[index];
    const text = (previous?.text ?? '') + chunk.text.slice(0, MAX_OUTPUT_CHARS - (previous?.text.length ?? 0));
    if (text === previous?.text) return false;
    const entry = Object.freeze({ taskId: task.id, channel: task.channel, text, state: 'streaming' } as const);
    if (task.id > writer) {
      this.change(writer, 'superseded');
      this.writers.set(task.channel, task.id);
    }
    if (previous) this.entries[index] = entry;
    else {
      this.entries.push(entry);
      if (this.entries.length > OUTPUT_HISTORY) {
        const oldestHistorical = this.entries.findIndex((entry) => this.writers.get(entry.channel) !== entry.taskId);
        this.entries.splice(oldestHistorical, 1);
      }
    }
    return true;
  }

  finish(task: InferenceTask, success: boolean): void {
    const entry = this.entries.find(({ taskId }) => taskId === task.id);
    if (entry?.state === 'streaming') this.change(task.id, success ? 'completed' : 'stopped');
  }

  retire(channel?: OutputChannel): void {
    for (const [target, writer] of this.writers) {
      if (channel === undefined || channel === target) this.change(writer, 'superseded');
    }
  }

  snapshot(): readonly OutputEntry[] {
    return [...this.entries];
  }

  private change(taskId: number, state: OutputEntry['state']): void {
    const index = this.entries.findIndex((entry) => entry.taskId === taskId);
    if (index >= 0) this.entries[index] = Object.freeze({ ...this.entries[index], state });
  }
}
