import { command } from "ccstate";

import type { PiEdgeTurnArgs } from "./pi-edge-config";
import type { RunnerJobNotification } from "./runner-dispatch.service";

export interface PendingRunActivation {
  readonly apiStartTime: number;
  readonly chatThreadId: string | undefined;
  readonly piEdgeTurn: PiEdgeTurnArgs | undefined;
  readonly runnerNotification: RunnerJobNotification;
}

/** Common post-commit activation for direct and promoted pending runs. */
export const activatePendingRun$ = command(
  async ({ set }, input: PendingRunActivation, signal: AbortSignal) => {
    // Imported lazily because Pi completion drains chat queues back through
    // run creation. Keeping that orchestration edge lazy preserves the static
    // service dependency DAG while both creation paths share this command.
    const { activatePendingRunInternal$ } =
      await import("./agent-run-activation-internal.service");
    signal.throwIfAborted();
    await set(activatePendingRunInternal$, input, signal);
  },
);
