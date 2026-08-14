import { command } from "ccstate";
import { insufficientCredits } from "../../lib/error";
import { db$ } from "../external/db";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

export const rejectSuspendedOrg$ = command(
  async (
    { get },
    orgId: string,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof insufficientCredits> | null> => {
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, orgId);
    signal.throwIfAborted();

    return capabilities?.status === "suspended" ? insufficientCredits() : null;
  },
);
