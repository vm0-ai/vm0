import { randomUUID } from "node:crypto";

import type { SendMode } from "@vm0/api-contracts/contracts/zero-user-preferences";
import type { SecretType } from "@vm0/api-contracts/contracts/secrets";
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

interface VariableSeedValues {
  readonly name: string;
  readonly value: string;
  readonly description?: string | null;
  readonly type?: "user" | "connector";
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

interface SecretSeedValues {
  readonly name: string;
  readonly description?: string | null;
  readonly type?: SecretType;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
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

export const seedVariables$ = command(
  async (
    { set },
    rows: readonly VariableSeedValues[],
    signal: AbortSignal,
  ): Promise<UserDataFixture> => {
    const fixture = createUserDataFixture();
    const writeDb = set(writeDb$);

    if (rows.length > 0) {
      await writeDb.insert(variables).values(
        rows.map((row) => {
          return {
            orgId: fixture.orgId,
            userId: fixture.userId,
            name: row.name,
            value: row.value,
            description: row.description ?? null,
            type: row.type ?? "user",
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        }),
      );
      signal.throwIfAborted();
    }

    return fixture;
  },
);

export const seedSecrets$ = command(
  async (
    { set },
    rows: readonly SecretSeedValues[],
    signal: AbortSignal,
  ): Promise<UserDataFixture> => {
    const fixture = createUserDataFixture();
    const writeDb = set(writeDb$);

    if (rows.length > 0) {
      await writeDb.insert(secrets).values(
        rows.map((row) => {
          return {
            orgId: fixture.orgId,
            userId: fixture.userId,
            name: row.name,
            encryptedValue: `encrypted_${row.name}`,
            description: row.description ?? null,
            type: row.type ?? "user",
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        }),
      );
      signal.throwIfAborted();
    }

    return fixture;
  },
);

export const seedOtherVariable$ = command(
  async (
    { set },
    fixture: UserDataFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(variables).values({
      orgId: fixture.orgId,
      userId: `user_${randomUUID()}`,
      name: "OTHER_USER_VAR",
      value: "other-user",
    });
    signal.throwIfAborted();
  },
);

export const seedOtherSecret$ = command(
  async (
    { set },
    fixture: UserDataFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(secrets).values({
      orgId: fixture.orgId,
      userId: `user_${randomUUID()}`,
      name: "OTHER_USER_SECRET",
      encryptedValue: "encrypted_other_user",
    });
    signal.throwIfAborted();
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
