import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

/**
 * Reads the persisted eligibility marker that intentionally has no product API.
 * Tests create it only through the verified Clerk webhook/bootstrap path.
 */
export async function readMorningBriefDefaultEligibilityFixture(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<Date | null> {
  const [row] = await createStore()
    .set(writeDb$)
    .select({ eligibleAt: orgMembersMetadata.morningBriefDefaultEligibleAt })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  return row?.eligibleAt ?? null;
}
