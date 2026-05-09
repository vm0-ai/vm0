import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import { command } from "ccstate";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq } from "drizzle-orm";

import { env } from "../../../../lib/env";
import { writeDb$ } from "../../../external/db";

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

function encryptSecretValueForTests(plaintext: string): string {
  const key = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    data.toString("base64"),
  ].join(":");
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
          encryptedValue: encryptSecretValueForTests("test-secret-value"),
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
