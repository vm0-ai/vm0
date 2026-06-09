import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";

import { writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "./encrypt-secret";

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
