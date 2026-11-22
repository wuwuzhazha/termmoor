/**
 * Small, dependency-free reliability helpers shared by the terminal host.
 *
 * Everything here is pure so it can be unit-tested without `vscode` or a
 * pseudo-terminal. Keeping the decisions here also makes the lifecycle code in
 * `TerminalProvider` easier to audit.
 */

/** Outcome of opening a path cited in terminal output. */
export type OpenPathOutcome = 'opened' | 'cancelled' | 'missing';

/**
 * Normalizes the (legacy boolean and current string) `openPath` result so the
 * host can distinguish a declined outside-workspace confirmation from a path
 * that genuinely does not exist. Only `missing` should ever surface a toast.
 */
export function normalizeOpenPathOutcome(result: unknown): OpenPathOutcome {
  if (result === true || result === 'opened') {
    return 'opened';
  }
  if (result === 'cancelled') {
    return 'cancelled';
  }
  return 'missing';
}

/** Tabs that would lose running work if closed or restarted right now. */
export function runningOrStartingTabs<T extends { running: boolean; starting?: boolean }>(
  tabs: readonly T[]
): T[] {
  return tabs.filter((tab) => tab.running || tab.starting === true);
}
