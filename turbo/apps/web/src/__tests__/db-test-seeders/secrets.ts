import { initServices } from "../../lib/init-services";
import type { SecretType } from "@vm0/api-contracts/contracts/secrets";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";

/**
 * Insert a user-level secret directly in the database.
 *
 * @why-db-direct Route isolation tests need rows owned by another user, another
 * org, or a non-user secret type. The public secrets API always writes the
 * authenticated user's active-org secret with type="user".
 */
export async function insertTestUserSecret(params: {
  orgId: string;
  userId: string;
  name: string;
  value?: string;
  description?: string | null;
  type?: SecretType;
}): Promise<{
  id: string;
  name: string;
  description: string | null;
  type: SecretType;
  createdAt: Date;
  updatedAt: Date;
}> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const encrypted = encryptSecretValue(
    params.value ?? "test-secret-value",
    SECRETS_ENCRYPTION_KEY,
  );
  const [secret] = await globalThis.services.db
    .insert(secrets)
    .values({
      name: params.name,
      encryptedValue: encrypted,
      type: params.type ?? "user",
      userId: params.userId,
      orgId: params.orgId,
      description: params.description ?? "test seed",
    })
    .returning({
      id: secrets.id,
      name: secrets.name,
      description: secrets.description,
      type: secrets.type,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    });

  if (!secret) {
    throw new Error("Expected inserted secret to return a row");
  }
  return {
    ...secret,
    type: secret.type as SecretType,
  };
}

/**
 * Insert a user-level variable directly in the database.
 *
 * @why-db-direct Route isolation tests need rows owned by another user or org.
 * The public variables API always writes the authenticated user's active-org
 * variable.
 */
export async function insertTestUserVariable(params: {
  orgId: string;
  userId: string;
  name: string;
  value?: string;
  description?: string | null;
}): Promise<{
  id: string;
  name: string;
  value: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  initServices();
  const description =
    "description" in params ? (params.description ?? null) : "test seed";
  const [variable] = await globalThis.services.db
    .insert(variables)
    .values({
      name: params.name,
      value: params.value ?? "test-variable-value",
      userId: params.userId,
      orgId: params.orgId,
      description,
    })
    .onConflictDoUpdate({
      target: [variables.orgId, variables.userId, variables.name],
      set: {
        value: params.value ?? "test-variable-value",
        description,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: variables.id,
      name: variables.name,
      value: variables.value,
      description: variables.description,
      createdAt: variables.createdAt,
      updatedAt: variables.updatedAt,
    });

  if (!variable) {
    throw new Error("insertTestUserVariable: insert failed");
  }

  return variable;
}
