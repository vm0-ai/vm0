import { command } from "ccstate";

import { writeDb$ } from "../external/db";
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

    return (
      availability !== null &&
      availability.status === "active" &&
      availability.spendableCredits > 0
    );
  },
);
