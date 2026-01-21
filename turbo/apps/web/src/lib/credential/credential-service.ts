import { eq, and } from "drizzle-orm";
import type { CredentialType } from "@vm0/core";
import { credentials } from "../../db/schema/credential";
import { encryptCredentialValue, decryptCredentialValue } from "../crypto";
import { BadRequestError, NotFoundError } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";

const log = logger("service:credential");

/**
 * Credential name validation regex
 * Rules:
 * - 1-255 characters
 * - uppercase letters, numbers, and underscores only
 * - must start with a letter
 */
const NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate credential name format
 */
export function validateCredentialName(name: string): void {
  if (name.length === 0 || name.length > 255) {
    throw new BadRequestError(
      "Credential name must be between 1 and 255 characters",
    );
  }

  if (!NAME_REGEX.test(name)) {
    throw new BadRequestError(
      "Credential name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
    );
  }
}

interface CredentialInfo {
  id: string;
  name: string;
  description: string | null;
  type: CredentialType;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * List all credentials for a user's scope (metadata only, no values)
 */
export async function listCredentials(
  clerkUserId: string,
): Promise<CredentialInfo[]> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return [];
  }

  const result = await globalThis.services.db
    .select({
      id: credentials.id,
      name: credentials.name,
      description: credentials.description,
      type: credentials.type,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(eq(credentials.scopeId, scope.id))
    .orderBy(credentials.name);

  return result.map((row) => ({
    ...row,
    type: row.type as CredentialType,
  }));
}

/**
 * Get a credential by name for a user's scope (metadata only)
 */
export async function getCredential(
  clerkUserId: string,
  name: string,
): Promise<CredentialInfo | null> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return null;
  }

  const result = await globalThis.services.db
    .select({
      id: credentials.id,
      name: credentials.name,
      description: credentials.description,
      type: credentials.type,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(and(eq(credentials.scopeId, scope.id), eq(credentials.name, name)))
    .limit(1);

  if (!result[0]) {
    return null;
  }

  return {
    ...result[0],
    type: result[0].type as CredentialType,
  };
}

/**
 * Get decrypted credential value by name
 * Used internally for variable expansion during agent execution
 */
export async function getCredentialValue(
  scopeId: string,
  name: string,
): Promise<string | null> {
  const result = await globalThis.services.db
    .select({
      encryptedValue: credentials.encryptedValue,
    })
    .from(credentials)
    .where(and(eq(credentials.scopeId, scopeId), eq(credentials.name, name)))
    .limit(1);

  if (!result[0]) {
    return null;
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  return decryptCredentialValue(result[0].encryptedValue, encryptionKey);
}

/**
 * Get all credential values for a scope as a map
 * Used for batch credential resolution during variable expansion
 */
export async function getCredentialValues(
  scopeId: string,
): Promise<Record<string, string>> {
  const result = await globalThis.services.db
    .select({
      name: credentials.name,
      encryptedValue: credentials.encryptedValue,
    })
    .from(credentials)
    .where(eq(credentials.scopeId, scopeId));

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const values: Record<string, string> = {};

  for (const row of result) {
    values[row.name] = decryptCredentialValue(
      row.encryptedValue,
      encryptionKey,
    );
  }

  return values;
}

/**
 * Create or update a credential (upsert)
 */
export async function setCredential(
  clerkUserId: string,
  name: string,
  value: string,
  description?: string,
): Promise<CredentialInfo> {
  validateCredentialName(name);

  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw new BadRequestError(
      "You need to configure a scope first. Run `vm0 scope create` to set up your scope.",
    );
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(value, encryptionKey);

  log.debug("setting credential", { scopeId: scope.id, name });

  // Check if credential exists
  const existing = await globalThis.services.db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.scopeId, scope.id), eq(credentials.name, name)))
    .limit(1);

  if (existing[0]) {
    // Update existing credential
    const [updated] = await globalThis.services.db
      .update(credentials)
      .set({
        encryptedValue,
        description: description ?? null,
        updatedAt: new Date(),
      })
      .where(eq(credentials.id, existing[0].id))
      .returning({
        id: credentials.id,
        name: credentials.name,
        description: credentials.description,
        type: credentials.type,
        createdAt: credentials.createdAt,
        updatedAt: credentials.updatedAt,
      });

    log.debug("credential updated", { credentialId: updated!.id, name });
    return {
      ...updated!,
      type: updated!.type as CredentialType,
    };
  }

  // Create new credential
  const [created] = await globalThis.services.db
    .insert(credentials)
    .values({
      scopeId: scope.id,
      name,
      encryptedValue,
      description: description ?? null,
    })
    .returning({
      id: credentials.id,
      name: credentials.name,
      description: credentials.description,
      type: credentials.type,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    });

  log.debug("credential created", { credentialId: created!.id, name });
  return {
    ...created!,
    type: created!.type as CredentialType,
  };
}

/**
 * Delete a credential by name
 */
export async function deleteCredential(
  clerkUserId: string,
  name: string,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw new NotFoundError("Credential not found");
  }

  const result = await globalThis.services.db
    .delete(credentials)
    .where(and(eq(credentials.scopeId, scope.id), eq(credentials.name, name)))
    .returning({ id: credentials.id });

  if (result.length === 0) {
    throw new NotFoundError(`Credential "${name}" not found`);
  }

  log.debug("credential deleted", { scopeId: scope.id, name });
}
