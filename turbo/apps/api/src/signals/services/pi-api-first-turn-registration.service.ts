import { command } from "ccstate";

import type { PiApiFirstTurnActivation } from "./pi-api-first-turn-config";
import { runPiApiFirstTurn$ } from "./pi-api-first-turn.service";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import { configurePiApiFirstTurnCommand } from "./pi-api-first-turn-dispatch.service";

const COMPLETE_SIDE_EFFECT_TIMEOUT_MS = 10_000;

const configuredPiApiFirstTurn$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    signal: AbortSignal,
  ): Promise<void> => {
    const sideEffects = await set(runPiApiFirstTurn$, activation, signal);
    if (sideEffects) {
      await set(
        dispatchCompleteSideEffects$,
        sideEffects,
        AbortSignal.timeout(COMPLETE_SIDE_EFFECT_TIMEOUT_MS),
      );
    }
  },
);

/** Wire the Pi API first-turn implementation at the API composition root. */
export function configurePiApiFirstTurnDispatcher(): void {
  configurePiApiFirstTurnCommand(configuredPiApiFirstTurn$);
}
