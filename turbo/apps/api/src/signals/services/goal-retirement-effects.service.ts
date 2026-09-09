import { command } from "ccstate";

import { now } from "../../lib/time";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { drainChatThreadQueueForRun$ } from "./chat-thread-queue-drain.service";
import {
  publishGoalRunRetirement,
  type RetiredGoalRun,
} from "./goal-retirement.service";

/** Commit-owned cleanup advances shared work without dispatching this run's callbacks. */
export const dispatchGoalRetirementEffects$ = command(
  async ({ set }, run: RetiredGoalRun, signal: AbortSignal): Promise<void> => {
    await publishGoalRunRetirement(run);
    signal.throwIfAborted();
    await set(
      drainChatThreadQueueForRun$,
      {
        runId: run.id,
        apiStartTime: now(),
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
  },
);
