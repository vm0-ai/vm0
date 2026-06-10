import { randomUUID } from "node:crypto";

import type { SendMode } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { command } from "ccstate";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { variables } from "@vm0/db/schema/variable";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface UserDataFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface UserPreferencesSeedValues {
  readonly timezone?: string | null;
  readonly pinnedAgentIds?: readonly string[];
  readonly sendMode?: SendMode;
  readonly captureNetworkBodiesRemaining?: number | null;
}

function createUserDataFixture(): UserDataFixture {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

export const seedUserPreferences$ = command(
  async (
    { set },
    values: UserPreferencesSeedValues,
    signal: AbortSignal,
  ): Promise<UserDataFixture> => {
    const fixture = createUserDataFixture();
    const writeDb = set(writeDb$);

    await writeDb.insert(orgMembersMetadata).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      timezone: values.timezone ?? null,
      pinnedAgentIds: [...(values.pinnedAgentIds ?? [])],
      sendMode: values.sendMode ?? "enter",
      captureNetworkBodiesRemaining: values.captureNetworkBodiesRemaining ?? 0,
    });
    signal.throwIfAborted();

    return fixture;
  },
);

export const deleteUserData$ = command(
  async (
    { set },
    fixture: UserDataFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb.delete(variables).where(eq(variables.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(userFeatureSwitches)
      .where(eq(userFeatureSwitches.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);
