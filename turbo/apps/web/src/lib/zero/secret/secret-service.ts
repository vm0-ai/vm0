import { eq, and } from "drizzle-orm";
import { type SecretType } from "@vm0/api-contracts/contracts/secrets";
import { secrets } from "@vm0/db/schema/secret";
import { encryptStoredSecretValue } from "../../shared/crypto/kms-secrets-encryption";
import { badRequest, notFound } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";

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
 * List all secrets for an org (metadata only, no values)
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

  return result.map((row) => {
    return {
      ...row,
      type: row.type as SecretType,
    };
  });
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

  const encryptedValue = await encryptStoredSecretValue(value);

  log.debug("setting secret", { orgId, name });

  const [result] = await globalThis.services.db
    .insert(secrets)
    .values({
      name,
      encryptedValue,
      description: description ?? null,
      type: "user",
      userId,
      orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue,
        description: description ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: secrets.id,
      name: secrets.name,
      description: secrets.description,
      type: secrets.type,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    });

  if (!result) {
    throw new Error("Expected upsert to return a row");
  }

  log.debug("secret upserted", { secretId: result.id, name });
  return {
    ...result,
    type: result.type as SecretType,
  };
}

/**
 * Delete a user secret by name
 * Note: Model-provider secrets are managed via model-provider commands
 */
async function deleteSecret(
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

// ============================================================================
// Org-Level Secret Functions
//
// These delegate to the user-level functions using ORG_SENTINEL_USER_ID.
// The sentinel userId ensures org and user secrets are fully isolated.
// ============================================================================

/**
 * List all org-level secrets (metadata only, no values)
 */
export function listOrgSecrets(orgId: string): Promise<SecretInfo[]> {
  return listSecrets(orgId, ORG_SENTINEL_USER_ID);
}

/**
 * Create or update an org-level secret
 */
export function setOrgSecret(
  orgId: string,
  name: string,
  value: string,
  description?: string,
): Promise<SecretInfo> {
  return setSecret(orgId, ORG_SENTINEL_USER_ID, name, value, description);
}

/**
 * Delete an org-level secret by name
 */
export function deleteOrgSecret(orgId: string, name: string): Promise<void> {
  return deleteSecret(orgId, ORG_SENTINEL_USER_ID, name);
}
