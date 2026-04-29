import { randomUUID } from "node:crypto";

import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { Store } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";

export interface VoiceIoQuotaFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface VoiceIoQuotaSeedValues {
  readonly tier?: OrgTier;
  readonly count?: number;
}

export async function seedVoiceIoQuotaOrg(
  store: Store,
  values: VoiceIoQuotaSeedValues = {},
): Promise<VoiceIoQuotaFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);

  if (values.tier) {
    await writeDb.insert(orgMetadata).values({
      orgId,
      tier: values.tier,
    });
  }

  if (values.count !== undefined) {
    await writeDb.insert(userBehaviorCount).values({
      orgId,
      userId,
      behaviorKey: AUDIO_INPUT_BEHAVIOR_KEY,
      count: values.count,
    });
  }

  return { orgId, userId };
}

export async function deleteVoiceIoQuotaOrg(
  store: Store,
  fixture: VoiceIoQuotaFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(userBehaviorCount)
    .where(
      and(
        eq(userBehaviorCount.orgId, fixture.orgId),
        eq(userBehaviorCount.userId, fixture.userId),
      ),
    );
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
}
