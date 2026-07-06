import { command, state } from "ccstate";

import { checkForceUpgrade } from "../lib/force-upgrade.ts";

const forceUpgradeDialogOpenState$ = state(false);

export const forceUpgradeDialogOpen$ = forceUpgradeDialogOpenState$;

export const checkForceUpgradeDialog$ = command(
  async ({ set }, _signal: AbortSignal) => {
    const required = await checkForceUpgrade();
    if (required) {
      set(forceUpgradeDialogOpenState$, true);
    }
  },
);
