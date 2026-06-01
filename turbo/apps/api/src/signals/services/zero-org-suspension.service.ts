import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { orgMetadata } from "@vm0/db/schema/org-metadata";

import { insufficientCredits } from "../../lib/error";
import { db$ } from "../external/db";

export const rejectSuspendedOrg$ = command(
  async (
    { get },
    orgId: string,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof insufficientCredits> | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();

    return row?.tier === "pro-suspend" ? insufficientCredits() : null;
  },
);
