import { eq, and, inArray } from "drizzle-orm";
import { userSecrets } from "../../db/schema/user-secrets";
import { encryptSecret, decryptSecret } from "./crypto";

export interface SecretInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create or update a user secret
 */
export async function upsertSecret(
  userId: string,
  name: string,
  value: string,
): Promise<{ action: "created" | "updated" }> {
  const encryptedValue = encryptSecret(value);

  // Check if secret exists
  const existing = await globalThis.services.db
    .select()
    .from(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.name, name)))
    .limit(1);

  if (existing.length > 0) {
    // Update existing secret
    await globalThis.services.db
      .update(userSecrets)
      .set({
        encryptedValue,
        updatedAt: new Date(),
      })
      .where(and(eq(userSecrets.userId, userId), eq(userSecrets.name, name)));

    return { action: "updated" };
  }

  // Create new secret
  await globalThis.services.db.insert(userSecrets).values({
    userId,
    name,
    encryptedValue,
  });

  return { action: "created" };
}

/**
 * List all secrets for a user (names only, not values)
 */
export async function listSecrets(userId: string): Promise<SecretInfo[]> {
  const secrets = await globalThis.services.db
    .select({
      name: userSecrets.name,
      createdAt: userSecrets.createdAt,
      updatedAt: userSecrets.updatedAt,
    })
    .from(userSecrets)
    .where(eq(userSecrets.userId, userId))
    .orderBy(userSecrets.name);

  return secrets.map((s) => ({
    name: s.name,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));
}

/**
 * Delete a secret by name
 */
export async function deleteSecret(
  userId: string,
  name: string,
): Promise<boolean> {
  const result = await globalThis.services.db
    .delete(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.name, name)))
    .returning({ id: userSecrets.id });

  return result.length > 0;
}

/**
 * Get decrypted secret values by names
 * Used internally for variable expansion - never expose to API
 */
export async function getSecretValues(
  userId: string,
  names: string[],
): Promise<Record<string, string>> {
  if (names.length === 0) {
    return {};
  }

  const secrets = await globalThis.services.db
    .select({
      name: userSecrets.name,
      encryptedValue: userSecrets.encryptedValue,
    })
    .from(userSecrets)
    .where(
      and(eq(userSecrets.userId, userId), inArray(userSecrets.name, names)),
    );

  const result: Record<string, string> = {};
  for (const secret of secrets) {
    result[secret.name] = decryptSecret(secret.encryptedValue);
  }

  return result;
}

/**
 * Get all decrypted secret values for a user.
 * Used internally for secret masking in event logs - never expose to API.
 */
export async function getAllSecretValues(userId: string): Promise<string[]> {
  const secrets = await globalThis.services.db
    .select({
      encryptedValue: userSecrets.encryptedValue,
    })
    .from(userSecrets)
    .where(eq(userSecrets.userId, userId));

  return secrets.map((secret) => decryptSecret(secret.encryptedValue));
}
