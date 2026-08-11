import { cronCustomConnectorSkillRepairContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import {
  customConnectorSkillRepairStatus$,
  repairCustomConnectorSkillVersions$,
} from "../services/cron-custom-connector-skill-repair.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const repairRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const result = await set(repairCustomConnectorSkillVersions$, signal);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { success: true as const, ...result },
  };
});

const statusRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const result = await set(customConnectorSkillRepairStatus$, signal);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { success: true as const, ...result },
  };
});

export const cronCustomConnectorSkillRepairRoutes: readonly RouteEntry[] = [
  {
    route: cronCustomConnectorSkillRepairContract.repair,
    handler: repairRoute$,
  },
  {
    route: cronCustomConnectorSkillRepairContract.status,
    handler: statusRoute$,
  },
];
