import { computed, type Computed } from "ccstate";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

export function zeroMemberCreditCap(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<
  Promise<{
    readonly creditCap: number | null;
    readonly creditEnabled: boolean;
  }>
> {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select({
        creditCap: orgMembersMetadata.creditCap,
        creditEnabled: orgMembersMetadata.creditEnabled,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1);

    return {
      creditCap: row?.creditCap ?? null,
      creditEnabled: row?.creditEnabled ?? true,
    };
  });
}
