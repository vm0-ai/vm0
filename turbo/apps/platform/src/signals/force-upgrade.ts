import { command, state } from "ccstate";

import { checkForceUpgrade } from "../lib/force-upgrade.ts";
import { setLoop } from "./utils.ts";

const FORCE_UPGRADE_POLL_INTERVAL_MS = 60_000;

const forceUpgradeDialogOpenState$ = state(false);

export const forceUpgradeDialogOpen$ = forceUpgradeDialogOpenState$;

type ForceUpgradePollOptions = {
  readonly check: () => Promise<boolean>;
  readonly onRequired: () => void;
  readonly pollIntervalMs?: number;
  readonly signal: AbortSignal;
};

export async function pollForceUpgradeRequirement({
  check,
  onRequired,
  pollIntervalMs = FORCE_UPGRADE_POLL_INTERVAL_MS,
  signal,
}: ForceUpgradePollOptions): Promise<void> {
  await setLoop(
    async (loopSignal) => {
      const required = await check();
      loopSignal.throwIfAborted();
      if (required) {
        onRequired();
      }
      return required;
    },
    pollIntervalMs,
    signal,
  );
}

export const pollForceUpgradeDialog$ = command(
  async ({ set }, _signal: AbortSignal) => {
    await pollForceUpgradeRequirement({
      check: checkForceUpgrade,
      onRequired: () => {
        set(forceUpgradeDialogOpenState$, true);
      },
      signal: _signal,
    });
  },
);
