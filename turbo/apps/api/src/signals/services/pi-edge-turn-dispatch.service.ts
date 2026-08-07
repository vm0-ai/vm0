import { command, createStore, state, type Command } from "ccstate";

import type { PiEdgeTurnArgs } from "./pi-edge-config";

type PiEdgeTurnCommand = Command<Promise<void>, [PiEdgeTurnArgs, AbortSignal]>;

const configuredPiEdgeTurnCommand$ = state<PiEdgeTurnCommand | undefined>(
  undefined,
);
const configurationStore = createStore();

/** Configure the Pi edge implementation once from the API composition root. */
export function configurePiEdgeTurnCommand(
  commandValue: PiEdgeTurnCommand,
): void {
  const configuredPiEdgeTurnCommand = configurationStore.get(
    configuredPiEdgeTurnCommand$,
  );
  if (
    configuredPiEdgeTurnCommand !== undefined &&
    configuredPiEdgeTurnCommand !== commandValue
  ) {
    throw new Error("Pi edge turn command is already configured");
  }
  configurationStore.set(configuredPiEdgeTurnCommand$, commandValue);
}

export const dispatchConfiguredPiEdgeTurn$ = command(
  async ({ set }, args: PiEdgeTurnArgs, signal: AbortSignal): Promise<void> => {
    const commandValue = configurationStore.get(configuredPiEdgeTurnCommand$);
    if (commandValue === undefined) {
      throw new Error("Pi edge turn command is not configured");
    }
    await set(commandValue, args, signal);
  },
);
