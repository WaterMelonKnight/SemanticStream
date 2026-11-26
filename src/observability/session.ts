/**
 * Runtime scheduler sessions and visual sampling sessions are separate.
 * Scheduler records are emitted only for the current runtime session and use a
 * runtime-prefixed identity, so a late journal record can never be relabeled as
 * the newly started visual session.
 */
export function isCurrentRuntimeSession(taskSession: number, currentSession: number): boolean {
  return taskSession === currentSession;
}

export function runtimeSessionId(taskSession: number): string {
  return `runtime-${taskSession}`;
}
