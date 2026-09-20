/** Process-wide guard for the short commit phase of a session replacement. */

let activeSessionTransitions = 0;

export function beginSessionTransition(): void {
  activeSessionTransitions++;
}

export function endSessionTransition(): void {
  activeSessionTransitions = Math.max(0, activeSessionTransitions - 1);
}

export function isSessionTransitionInProgress(): boolean {
  return activeSessionTransitions > 0;
}
