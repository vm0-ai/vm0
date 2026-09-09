import { command } from "ccstate";

import type { Db } from "../external/db";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import type { GoalBootstrap } from "./goal.service";

// Compatibility entry points for old bootstrap/callback callers. Remove after
// outgoing API contexts and callbacks drain under the #32653 cutoff gate.
export const handleTerminalGoalContinuation$ = command(
  (
    _context,
    _args: { readonly db: Db; readonly runId: string },
    signal: AbortSignal,
  ): Promise<{ readonly kind: "skipped"; readonly reason: "goal-retired" }> => {
    signal.throwIfAborted();
    return Promise.resolve({ kind: "skipped", reason: "goal-retired" });
  },
);

export const bootstrapGoalRun$ = command(
  (
    _context,
    _args: {
      readonly db: Db;
      readonly goal: GoalBootstrap;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly kind: "failed-to-enqueue";
    readonly reason: "goal-retired";
  }> => {
    signal.throwIfAborted();
    return Promise.resolve({
      kind: "failed-to-enqueue",
      reason: "goal-retired",
    });
  },
);
