import { command } from "ccstate";

import type { PiApiFirstTurnActivation } from "./pi-api-first-turn-config";
import { runPiApiFirstTurn$ } from "./pi-api-first-turn.service";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import { configurePiApiFirstTurnCommand } from "./pi-api-first-turn-dispatch.service";
import { registerPiApiFirstTurnCancellation } from "./pi-api-first-turn-lifecycle.service";

const COMPLETE_SIDE_EFFECT_TIMEOUT_MS = 10_000;

const configuredPiApiFirstTurn$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    signal: AbortSignal,
  ): Promise<void> => {
    const cancellation = registerPiApiFirstTurnCancellation(
      activation.runId,
      signal,
    );
    const operation = (async () => {
      const sideEffects = await set(
        runPiApiFirstTurn$,
        activation,
        cancellation.signal,
      );
      cancellation.signal.throwIfAborted();
      if (sideEffects) {
        await set(
          dispatchCompleteSideEffects$,
          sideEffects,
          AbortSignal.timeout(COMPLETE_SIDE_EFFECT_TIMEOUT_MS),
        );
      }
    })();
    await operation.finally(() => {
      cancellation.release();
    });
  },
);

/** Wire the Pi API first-turn implementation at the API composition root. */
export function configurePiApiFirstTurnDispatcher(): void {
  configurePiApiFirstTurnCommand(configuredPiApiFirstTurn$);
}
