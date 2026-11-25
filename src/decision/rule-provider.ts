import { DECISION_ACTIONS } from './types';
import type {
  DecisionCandidate,
  DecisionProvider,
  DecisionProviderResult,
  DecisionState,
  TaskPriority,
} from './types';

export interface RuleBasedDecisionConfig {
  readonly globalThreshold: number;
  readonly localThreshold: number;
  readonly roiThreshold: number;
  readonly repeatSuppressionCount: number;
  readonly lowRealtimeFrames: number;
}

const DEFAULT_CONFIG: RuleBasedDecisionConfig = {
  globalThreshold: 1.5,
  localThreshold: 2.5,
  roiThreshold: 2.5,
  repeatSuppressionCount: 3,
  lowRealtimeFrames: 2,
};

const ACTION_PRIORITY: Readonly<Record<string, number>> = {
  SEND_FRAME: 100,
  SEND_PREVIEW: 90,
  REQUEST_REGION: 80,
  REQUEST_HISTORY: 70,
  ESCALATE: 60,
  WAIT: 10,
  DROP: 0,
};

const PRIORITY_BONUS: Readonly<Record<TaskPriority, number>> = {
  low: 0,
  normal: 0.05,
  high: 0.1,
};

function clamp(score: number): number {
  return Math.max(0, Math.min(1, score));
}

/**
 * Deterministic heuristic provider. Scores are rule weights, not calibrated
 * probabilities. The provider only returns actions; it cannot change budgets,
 * mutate the buffer, or bypass admission.
 */
export class RuleBasedDecisionProvider implements DecisionProvider {
  readonly id = 'rule-based';
  readonly scoreKind = 'heuristic' as const;

  constructor(private readonly config: RuleBasedDecisionConfig = DEFAULT_CONFIG) {}

  decide(state: DecisionState): DecisionProviderResult {
    const roiHot = state.roi !== null && state.roi.changePercent >= this.config.roiThreshold;
    const localHot = state.change.localPercent >= this.config.localThreshold;
    const globalHot = state.change.globalPercent >= this.config.globalThreshold;
    const repeated = state.recent.repeatedRoiChangeCount >= this.config.repeatSuppressionCount
      || state.recent.repeatedChangeCount >= this.config.repeatSuppressionCount + 1;
    const noRealtime = state.budget.realtimeRemainingFrames <= 0;
    const lowRealtime = state.budget.realtimeRemainingFrames <= this.config.lowRealtimeFrames;
    const noRetrieval = state.budget.retrievalRemainingFrames <= 0;
    const hasHistory = state.cache.availableRange !== null;
    const priorityBonus = PRIORITY_BONUS[state.task.priority];

    const candidates: DecisionCandidate[] = [];
    const add = (action: DecisionCandidate['action'], score: number, reason: string): void => {
      candidates.push({
        action,
        score: clamp(score),
        priority: ACTION_PRIORITY[action] ?? 0,
        reason,
      });
    };

    let sendScore = 0.08 + priorityBonus;
    if (roiHot) sendScore += 0.55;
    if (localHot) sendScore += 0.18;
    if (globalHot) sendScore += 0.08;
    if (repeated) sendScore -= 0.32;
    if (lowRealtime) sendScore -= 0.12;
    if (noRealtime) sendScore -= 0.8;
    add('SEND_FRAME', sendScore, roiHot ? 'ROI change is above threshold.' : 'Local/global change is actionable.');

    add(
      'SEND_PREVIEW',
      (globalHot && !roiHot ? 0.46 : 0.16) - (noRealtime ? 0.5 : 0) + priorityBonus,
      'Preview only; global motion without a focused ROI change.',
    );

    add(
      'REQUEST_REGION',
      (roiHot && (repeated || lowRealtime) ? 0.58 : 0.18)
        - (noRetrieval ? 0.8 : 0)
        - (!hasHistory ? 0.4 : 0)
        + priorityBonus,
      'Request the ROI from the bounded history instead of another full frame.',
    );

    add(
      'REQUEST_HISTORY',
      ((noRealtime || state.recent.budgetDeniedCount > 0) && (localHot || roiHot) ? 0.6 : 0.12)
        - (noRetrieval ? 0.8 : 0)
        - (!hasHistory ? 0.4 : 0)
        + priorityBonus,
      'Real-time budget or a prior denial makes history retrieval useful.',
    );

    add(
      'ESCALATE',
      ((state.task.priority === 'high' && roiHot && (noRealtime || repeated)) ? 0.5 : 0.05)
        + priorityBonus,
      'High-priority task with constrained real-time capacity.',
    );

    add(
      'WAIT',
      (globalHot || localHot || roiHot) ? (repeated ? 0.52 : 0.2) : 0.4,
      'Wait for a more informative or less repetitive frame.',
    );

    add('DROP', (globalHot || localHot || roiHot) ? 0.05 : 0.3, 'No actionable change.');

    candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.priority !== left.priority) return right.priority - left.priority;
      return DECISION_ACTIONS.indexOf(left.action) - DECISION_ACTIONS.indexOf(right.action);
    });
    const selected = candidates[0] ?? { action: 'WAIT' as const, score: 0, priority: 10, reason: 'No candidate.' };
    return {
      action: selected.action,
      candidates,
      scoreKind: 'heuristic',
      reason: selected.reason,
    };
  }
}
