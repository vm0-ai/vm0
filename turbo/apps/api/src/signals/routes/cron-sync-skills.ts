import { cronSyncSkillsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { syncSkills$ } from "../services/cron-sync-skills.service";
import { cronUnauthorized, hasValidCronSecret } from "./cron-auth";

const syncSkillsRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!hasValidCronSecret(get)) {
    return cronUnauthorized();
  }

  const result = await set(syncSkills$, signal);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { success: true as const, ...result },
  };
});

export const cronSyncSkillsRoutes: readonly RouteEntry[] = [
  {
    route: cronSyncSkillsContract.sync,
    handler: syncSkillsRoute$,
  },
];
