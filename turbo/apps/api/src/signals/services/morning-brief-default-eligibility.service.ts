import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { command } from "ccstate";
import { isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  ensureMorningBriefDefaultEnabled$,
  type EnsureMorningBriefDefaultEnabledResult,
} from "./morning-brief-preference.service";
import type { WorkflowMember } from "./workflow-data.service";

type MorningBriefEligibilityWriter = Pick<Db, "insert">;

interface RecordMorningBriefDefaultEligibilityArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly eligibleAt: Date;
}

/**
 * Records the first verified membership event that makes one user-org pair
 * eligible for default Morning Brief installation.
 */
export async function recordMorningBriefDefaultEligibility(
  db: MorningBriefEligibilityWriter,
  args: RecordMorningBriefDefaultEligibilityArgs,
): Promise<void> {
  const recordedAt = nowDate();
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      morningBriefDefaultEligibleAt: args.eligibleAt,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        morningBriefDefaultEligibleAt: args.eligibleAt,
        updatedAt: recordedAt,
      },
      setWhere: isNull(orgMembersMetadata.morningBriefDefaultEligibleAt),
    });
}

export const provisionNewMembershipMorningBrief$ = command(
  async (
    { set },
    args: RecordMorningBriefDefaultEligibilityArgs & {
      readonly member: WorkflowMember;
    },
    signal: AbortSignal,
  ): Promise<EnsureMorningBriefDefaultEnabledResult> => {
    await recordMorningBriefDefaultEligibility(set(writeDb$), args);
    signal.throwIfAborted();
    return await set(
      ensureMorningBriefDefaultEnabled$,
      { orgId: args.orgId, member: args.member },
      signal,
    );
  },
);
