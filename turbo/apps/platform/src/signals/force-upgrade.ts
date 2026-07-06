import { command, state } from "ccstate";
import { delay } from "signal-timers";

import { checkForceUpgrade } from "../lib/force-upgrade.ts";

const FORCE_UPGRADE_POLL_INTERVAL_MS = 60_000;

const forceUpgradeDialogOpenState$ = state(false);

export const forceUpgradeDialogOpen$ = forceUpgradeDialogOpenState$;

export type ForceUpgradePollOptions = {
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
  while (!signal.aborted) {
    signal.throwIfAborted();
    const required = await check();
    if (required) {
      onRequired();
      return;
    }
    await delay(pollIntervalMs, { signal });
  }
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
