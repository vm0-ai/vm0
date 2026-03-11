import { eq, and } from "drizzle-orm";
import { type SecretType } from "@vm0/core";
import { secrets } from "../../db/schema/secret";
import { encryptSecretValue, decryptSecretValue } from "../crypto";
import { badRequest, notFound } from "../errors";
import { logger } from "../logger";

const log = logger("service:secret");

/**
 * Secret name validation regex
 * Rules:
 * - 1-255 characters
 * - uppercase letters, numbers, and underscores only
 * - must start with a letter
 */
const NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate secret name format
 */
function validateSecretName(name: string): void {
  if (name.length === 0 || name.length > 255) {
    throw badRequest("Secret name must be between 1 and 255 characters");
  }

  if (!NAME_REGEX.test(name)) {
    throw badRequest(
      "Secret name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
    );
  }
}

interface SecretInfo {
  id: string;
  name: string;
  description: string | null;
  type: SecretType;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * List all secrets for a scope (metadata only, no values)
 */
export async function listSecrets(
  orgId: string,
  userId: string,
): Promise<SecretInfo[]> {
  const result = await globalThis.services.db
    .select({
      id: secrets.id,
      name: secrets.name,
      description: secrets.description,
      type: secrets.type,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .where(and(eq(secrets.orgId, orgId), eq(secrets.userId, userId)))
    .orderBy(secrets.name);

  return result.map((row) => ({
    ...row,
    type: row.type as SecretType,
  }));
}

/**
 * Get a secret by name for a user's default scope (metadata only)
 * Only returns user-type secrets; model-provider secrets are managed via model-provider commands
 */
export async function getSecret(
  orgId: string,
  userId: string,
  name: string,
): Promise<SecretInfo | null> {
  const result = await globalThis.services.db
    .select({
      id: secrets.id,
      name: secrets.name,
      description: secrets.description,
      type: secrets.type,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.name, name),
        eq(secrets.type, "user"),
      ),
    )
    .limit(1);

  if (!result[0]) {
    return null;
  }

  return {
    ...result[0],
    type: result[0].type as SecretType,
  };
}

/**
 * Get decrypted secret value by name
 * Used internally for variable expansion during agent execution
 * @param type - Optional type filter to isolate user vs model-provider secrets
 */
export async function getSecretValue(
  orgId: string,
  userId: string,
  name: string,
  type?: SecretType,
): Promise<string | null> {
  const conditions = [
    eq(secrets.orgId, orgId),
    eq(secrets.userId, userId),
    eq(secrets.name, name),
  ];
  if (type) {
    conditions.push(eq(secrets.type, type));
  }

  const result = await globalThis.services.db
    .select({
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .where(and(...conditions))
    .limit(1);

  if (!result[0]) {
    return null;
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  return decryptSecretValue(result[0].encryptedValue, encryptionKey);
}

/**
 * Get all secret values for a scope as a map
 * Used for batch secret resolution during variable expansion
 * @param type - Optional type filter to isolate user vs model-provider secrets
 */
export async function getSecretValues(
  orgId: string,
  userId: string,
  type?: SecretType,
): Promise<Record<string, string>> {
  const conditions = [eq(secrets.orgId, orgId), eq(secrets.userId, userId)];
  if (type) {
    conditions.push(eq(secrets.type, type));
  }

  const result = await globalThis.services.db
    .select({
      name: secrets.name,
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .where(and(...conditions));

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const values: Record<string, string> = {};

  for (const row of result) {
    values[row.name] = decryptSecretValue(row.encryptedValue, encryptionKey);
  }

  return values;
}

/**
 * Upsert a secret by scope ID, name, and type.
 * Used internally by connector services for managing connector/model-provider secrets.
 */
export async function upsertSecretByScope(
  orgId: string,
  userId: string,
  name: string,
  value: string,
  type: SecretType,
  description: string,
): Promise<void> {
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptSecretValue(value, encryptionKey);

  const [existing] = await globalThis.services.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.name, name),
        eq(secrets.type, type),
      ),
    )
    .limit(1);

  if (existing) {
    await globalThis.services.db
      .update(secrets)
      .set({ encryptedValue, updatedAt: new Date() })
      .where(eq(secrets.id, existing.id));
  } else {
    await globalThis.services.db.insert(secrets).values({
      userId,
      name,
      encryptedValue,
      type,
      description,
      orgId,
    });
  }
}

/**
 * Create or update a secret (upsert)
 */
export async function setSecret(
  orgId: string,
  userId: string,
  name: string,
  value: string,
  description?: string,
): Promise<SecretInfo> {
  validateSecretName(name);

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptSecretValue(value, encryptionKey);

  log.debug("setting secret", { orgId, name });

  // Check if user secret exists with same name
  // Note: We only check for user type to allow coexistence with model-provider secrets
  const existing = await globalThis.services.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.name, name),
        eq(secrets.type, "user"),
      ),
    )
    .limit(1);

  if (existing[0]) {
    // Update existing secret
    const [updated] = await globalThis.services.db
      .update(secrets)
      .set({
        encryptedValue,
        description: description ?? null,
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existing[0].id))
      .returning({
        id: secrets.id,
        name: secrets.name,
        description: secrets.description,
        type: secrets.type,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
      });

    log.debug("secret updated", { secretId: updated!.id, name });
    return {
      ...updated!,
      type: updated!.type as SecretType,
    };
  }

  // Create new secret
  const [created] = await globalThis.services.db
    .insert(secrets)
    .values({
      name,
      encryptedValue,
      description: description ?? null,
      userId,
      orgId,
    })
    .returning({
      id: secrets.id,
      name: secrets.name,
      description: secrets.description,
      type: secrets.type,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    });

  log.debug("secret created", { secretId: created!.id, name });
  return {
    ...created!,
    type: created!.type as SecretType,
  };
}

/**
 * Delete a user secret by name
 * Note: Model-provider secrets are managed via model-provider commands
 */
export async function deleteSecret(
  orgId: string,
  userId: string,
  name: string,
): Promise<void> {
  // Check if this user secret exists
  const [secret] = await globalThis.services.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.name, name),
        eq(secrets.type, "user"),
      ),
    )
    .limit(1);

  if (!secret) {
    throw notFound(`Secret "${name}" not found`);
  }

  await globalThis.services.db.delete(secrets).where(eq(secrets.id, secret.id));

  log.debug("secret deleted", { orgId, name });
}
