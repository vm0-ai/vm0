import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";
import { resolveOrgCreditAvailability } from "./zero-run-admission.service";

export const checkBillableOperationCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const availability = await resolveOrgCreditAvailability({
      db: writeDb,
      orgId: args.orgId,
    });
    signal.throwIfAborted();

    if (!availability || availability.status !== "active") {
      return false;
    }
    if (availability.spendableCredits > 0) {
      return true;
    }

    const allowance = await resolveUsageAllowanceAvailability(
      writeDb,
      args.orgId,
    );
    signal.throwIfAborted();
    return (allowance?.remainingUnits ?? 0) > 0;
  },
);
