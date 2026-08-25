import { command, createStore, state, type Command } from "ccstate";

import type { PiApiFirstTurnActivation } from "./pi-api-first-turn-config";

type PiApiFirstTurnCommand = Command<
  Promise<void>,
  [PiApiFirstTurnActivation, AbortSignal]
>;

const configuredPiApiFirstTurnCommand$ = state<
  PiApiFirstTurnCommand | undefined
>(undefined);
const configurationStore = createStore();

/** Configure the Pi API first-turn implementation from the API composition root. */
export function configurePiApiFirstTurnCommand(
  commandValue: PiApiFirstTurnCommand,
): void {
  const configuredCommand = configurationStore.get(
    configuredPiApiFirstTurnCommand$,
  );
  if (configuredCommand !== undefined && configuredCommand !== commandValue) {
    throw new Error("Pi API first-turn command is already configured");
  }
  configurationStore.set(configuredPiApiFirstTurnCommand$, commandValue);
}

export const dispatchConfiguredPiApiFirstTurn$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    signal: AbortSignal,
  ): Promise<void> => {
    const commandValue = configurationStore.get(
      configuredPiApiFirstTurnCommand$,
    );
    if (commandValue === undefined) {
      throw new Error("Pi API first-turn command is not configured");
    }
    await set(commandValue, activation, signal);
  },
);
