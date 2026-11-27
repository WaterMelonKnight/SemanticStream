import { normalizedCategory } from '../perception/tracking/tracker';
import type { ObjectEvent, ObjectRegion, TrackedObject } from '../perception/tracking/types';

export type AgentTask =
  | { readonly type: 'object'; readonly category?: string; readonly trackId?: string; readonly movement: boolean }
  | { readonly type: 'region'; readonly region: ObjectRegion; readonly category?: string }
  | { readonly type: 'summary' }
  | { readonly type: 'monitor' };

export type TaskStatus = 'active' | 'paused' | 'terminated';
export type PolicyAction = 'IGNORE' | 'WAIT' | 'RETRIEVE' | 'RESPOND' | 'ESCALATE';

export type AgentInput =
  | { readonly kind: 'object'; readonly event: ObjectEvent; readonly current?: TrackedObject }
  | { readonly kind: 'monitor'; readonly critical: boolean }
  | { readonly kind: 'summary' | 'question' };

export interface DecisionContext {
  readonly input: AgentInput;
  readonly task: AgentTask;
  readonly status: TaskStatus;
  readonly fresh: boolean;
  readonly cooling: boolean;
  readonly saturated: boolean;
  readonly budgetAvailable: boolean;
}

export interface PolicyDecision {
  readonly action: PolicyAction;
  readonly reason: string;
}

/** A decision can propose an action. The session still controls evidence, output and admission. */
export interface AgentDecisionProvider {
  decide(context: DecisionContext): PolicyDecision;
}

const PRESENCE = new Set(['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST', 'OBJECT_REAPPEARED']);
const CROSSING = new Set(['OBJECT_ENTERED_REGION', 'OBJECT_LEFT_REGION']);

export function isImportant(input: AgentInput): boolean {
  return input.kind === 'monitor' ? input.critical : input.kind === 'object'
    && (input.event.eventType === 'OBJECT_REAPPEARED' || input.event.eventType === 'OBJECT_TEMPORARILY_LOST'
      || CROSSING.has(input.event.eventType));
}

export const rulePolicy: AgentDecisionProvider = {
  decide(context) {
    const { input, task } = context;
    const manual = input.kind === 'question' || input.kind === 'summary';
    if (!manual && context.status !== 'active') return { action: 'IGNORE', reason: 'Task monitoring is paused or ended' };
    if (!context.fresh) return { action: 'IGNORE', reason: 'Event has passed its freshness window' };
    if (input.kind === 'monitor' && task.type !== 'monitor') return { action: 'IGNORE', reason: 'System monitor event is outside the task' };
    if (input.kind === 'object') {
      const { event, current } = input;
      const target = task.type === 'object' || task.type === 'region';
      if (!target || (task.category && normalizedCategory(event.categoryName) !== task.category)
        || (task.type === 'object' && task.trackId && task.trackId !== event.trackId)) {
        return { action: 'IGNORE', reason: 'Object is outside the watched target' };
      }
      if (event.eventType === 'OBJECT_EXPIRED') return { action: 'WAIT', reason: 'Track expired. Physical removal is unknown' };
      if (!current || current.trackingState !== event.currentState) return { action: 'IGNORE', reason: 'A newer object state replaced this event' };
      const relevant = task.type === 'region' ? CROSSING.has(event.eventType)
        : PRESENCE.has(event.eventType) || (task.movement && event.eventType === 'OBJECT_MOVED');
      if (!relevant) return { action: 'IGNORE', reason: 'Object change does not trigger this template' };
      if (event.associationUncertain || event.confidence < 0.45) {
        return { action: 'RETRIEVE', reason: 'Association or detector score warrants local evidence review' };
      }
    }
    if (context.cooling && !manual && !isImportant(input)) return { action: 'WAIT', reason: 'Similar event is cooling down' };
    if (!context.budgetAvailable) return { action: 'WAIT', reason: 'Request or token budget is unavailable' };
    if (context.saturated && !manual && !isImportant(input)) return { action: 'WAIT', reason: 'Queue is full; keeping existing work' };
    return isImportant(input) ? { action: 'ESCALATE', reason: 'Relevant state transition has priority' }
      : { action: 'RESPOND', reason: manual ? 'Explicit user request' : 'Relevant fresh change' };
  },
};

/** The unfiltered comparison retains freshness checks and uses the same hard ledgers. */
export const allEligiblePolicy: AgentDecisionProvider = {
  decide({ fresh, status, input }) {
    if (!fresh || (status !== 'active' && input.kind !== 'question' && input.kind !== 'summary')) {
      return { action: 'IGNORE', reason: 'Inactive or stale event' };
    }
    return { action: isImportant(input) ? 'ESCALATE' : 'RESPOND', reason: 'Every eligible event is offered to the scheduler' };
  },
};
