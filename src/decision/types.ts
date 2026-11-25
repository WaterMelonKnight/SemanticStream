import type { PixelRegion, TimeRange } from '../core/context-buffer';

export type TaskCategory =
  | 'text-reading'
  | 'motion-monitoring'
  | 'general-inspection'
  | 'interaction';

export type TaskPriority = 'low' | 'normal' | 'high';

export interface TaskDefinition {
  readonly id: string;
  readonly label: string;
  readonly category: TaskCategory;
  readonly priority: TaskPriority;
  /** ROI in 96 × 54 sample pixels. Declared by the user, never derived from evaluator labels. */
  readonly roi: PixelRegion | null;
}

export type DecisionAction =
  | 'SEND_FRAME'
  | 'SEND_PREVIEW'
  | 'DROP'
  | 'WAIT'
  | 'REQUEST_HISTORY'
  | 'REQUEST_REGION'
  | 'ESCALATE';

export const DECISION_ACTIONS: readonly DecisionAction[] = [
  'SEND_FRAME',
  'SEND_PREVIEW',
  'DROP',
  'WAIT',
  'REQUEST_HISTORY',
  'REQUEST_REGION',
  'ESCALATE',
];

export type ScoreKind = 'heuristic' | 'model-probability';

export interface DecisionBudgetState {
  readonly realtimeRemainingFrames: number;
  readonly realtimeRemainingBytes: number;
  readonly retrievalRemainingFrames: number;
  readonly retrievalRemainingBytes: number;
  readonly totalRemainingFrames: number;
  readonly totalRemainingBytes: number;
}

export interface DecisionCacheState {
  readonly availableRange: TimeRange | null;
  readonly capturedRange: TimeRange | null;
  readonly frameCount: number;
  readonly byteCount: number;
}

export interface RecentDecision {
  readonly timestampMs: number;
  readonly action: DecisionAction;
  readonly reason: string;
}

export interface DecisionChangeState {
  readonly globalPercent: number;
  readonly localPercent: number;
  readonly changedBlocks: number;
  readonly totalBlocks: number;
}

export interface DecisionRoiState {
  readonly region: PixelRegion;
  readonly changePercent: number;
}

export interface DecisionRecentState {
  readonly repeatedChangeCount: number;
  readonly repeatedRoiChangeCount: number;
  readonly budgetDeniedCount: number;
  readonly recentDecisions: readonly RecentDecision[];
}

export interface DecisionState {
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly task: TaskDefinition;
  readonly change: DecisionChangeState;
  readonly roi: DecisionRoiState | null;
  readonly recent: DecisionRecentState;
  readonly budget: DecisionBudgetState;
  readonly cache: DecisionCacheState;
}

export interface DecisionCandidate {
  readonly action: DecisionAction;
  readonly score: number;
  readonly priority: number;
  readonly reason: string;
}

export interface DecisionProviderResult {
  readonly action: DecisionAction;
  readonly candidates: readonly DecisionCandidate[];
  readonly scoreKind: ScoreKind;
  readonly reason: string;
}

export interface DecisionResult extends DecisionProviderResult {
  readonly providerId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly latencyMs: number;
  readonly timeoutMs: number;
  readonly degraded: boolean;
}

export interface DecisionProvider {
  readonly id: string;
  readonly scoreKind: ScoreKind;
  decide(state: DecisionState, signal?: AbortSignal): Promise<DecisionProviderResult> | DecisionProviderResult;
}

/** Design hook only; no network implementation is provided in Phase 3A. */
export interface HttpDecisionProviderConfig {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly modelId?: string;
}
