import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "./encrypt-secret";

const ORG_SENTINEL_USER_ID = "__org__";

export interface OrgModelProviderFixture {
  readonly orgId: string;
}

interface SeedOrgModelProviderValues {
  readonly orgId: string;
  readonly type: string;
  readonly isDefault?: boolean;
  readonly selectedModel?: string | null;
  readonly secretName?: string | null;
  readonly authMethod?: string | null;
}

export const seedOrgModelProvider$ = command(
  async (
    { set },
    values: SeedOrgModelProviderValues,
    signal: AbortSignal,
  ): Promise<{ readonly id: string }> => {
    const writeDb = set(writeDb$);

    let secretId: string | null = null;
    if (values.secretName) {
      const [secret] = await writeDb
        .insert(secrets)
        .values({
          name: values.secretName,
          encryptedValue: encryptSecretForTests("test-secret-value"),
          type: "model-provider",
          userId: ORG_SENTINEL_USER_ID,
          orgId: values.orgId,
        })
        .returning({ id: secrets.id });
      signal.throwIfAborted();
      secretId = secret?.id ?? null;
    }

    const [row] = await writeDb
      .insert(modelProviders)
      .values({
        type: values.type,
        secretId,
        authMethod: values.authMethod ?? null,
        isDefault: values.isDefault ?? false,
        selectedModel: values.selectedModel ?? null,
        userId: ORG_SENTINEL_USER_ID,
        orgId: values.orgId,
      })
      .returning({ id: modelProviders.id });
    signal.throwIfAborted();

    return { id: row?.id ?? randomUUID() };
  },
);

export const deleteOrgModelProviders$ = command(
  async (
    { set },
    fixture: OrgModelProviderFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, fixture.orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, ORG_SENTINEL_USER_ID),
        ),
      );
    signal.throwIfAborted();
  },
);

export interface UserModelProviderFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SeedUserModelProviderValues {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
  readonly isDefault?: boolean;
  readonly selectedModel?: string | null;
  readonly secretName?: string | null;
  readonly authMethod?: string | null;
}

export const seedUserModelProvider$ = command(
  async (
    { set },
    values: SeedUserModelProviderValues,
    signal: AbortSignal,
  ): Promise<{ readonly id: string }> => {
    const writeDb = set(writeDb$);

    let secretId: string | null = null;
    if (values.secretName) {
      const [secret] = await writeDb
        .insert(secrets)
        .values({
          name: values.secretName,
          encryptedValue: encryptSecretForTests("test-secret-value"),
          type: "model-provider",
          userId: values.userId,
          orgId: values.orgId,
        })
        .returning({ id: secrets.id });
      signal.throwIfAborted();
      secretId = secret?.id ?? null;
    }

    const [row] = await writeDb
      .insert(modelProviders)
      .values({
        type: values.type,
        secretId,
        authMethod: values.authMethod ?? null,
        isDefault: values.isDefault ?? false,
        selectedModel: values.selectedModel ?? null,
        userId: values.userId,
        orgId: values.orgId,
      })
      .returning({ id: modelProviders.id });
    signal.throwIfAborted();

    return { id: row?.id ?? randomUUID() };
  },
);

export const deleteUserModelProviders$ = command(
  async (
    { set },
    fixture: UserModelProviderFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, fixture.orgId),
          eq(modelProviders.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
