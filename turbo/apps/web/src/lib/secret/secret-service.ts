import { eq, and, inArray } from "drizzle-orm";
import {
  type SecretType,
  type ModelProviderType,
  getCredentialNamesForAuthMethod,
  getFrameworkForType,
} from "@vm0/core";
import { secrets } from "../../db/schema/secret";
import { modelProviders } from "../../db/schema/model-provider";
import { encryptCredentialValue, decryptCredentialValue } from "../crypto";
import { badRequest, notFound } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";

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
 * List all secrets for a user's scope (metadata only, no values)
 */
export async function listSecrets(clerkUserId: string): Promise<SecretInfo[]> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return [];
  }

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
    .where(eq(secrets.scopeId, scope.id))
    .orderBy(secrets.name);

  return result.map((row) => ({
    ...row,
    type: row.type as SecretType,
  }));
}

/**
 * Get a secret by name for a user's scope (metadata only)
 */
export async function getSecret(
  clerkUserId: string,
  name: string,
): Promise<SecretInfo | null> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return null;
  }

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
    .where(and(eq(secrets.scopeId, scope.id), eq(secrets.name, name)))
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
 */
export async function getSecretValue(
  scopeId: string,
  name: string,
): Promise<string | null> {
  const result = await globalThis.services.db
    .select({
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .where(and(eq(secrets.scopeId, scopeId), eq(secrets.name, name)))
    .limit(1);

  if (!result[0]) {
    return null;
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  return decryptCredentialValue(result[0].encryptedValue, encryptionKey);
}

/**
 * Get all secret values for a scope as a map
 * Used for batch secret resolution during variable expansion
 */
export async function getSecretValues(
  scopeId: string,
): Promise<Record<string, string>> {
  const result = await globalThis.services.db
    .select({
      name: secrets.name,
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .where(eq(secrets.scopeId, scopeId));

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
 * Create or update a secret (upsert)
 */
export async function setSecret(
  clerkUserId: string,
  name: string,
  value: string,
  description?: string,
): Promise<SecretInfo> {
  validateSecretName(name);

  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw badRequest(
      "You need to configure a scope first. Run `vm0 scope create` to set up your scope.",
    );
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(value, encryptionKey);

  log.debug("setting secret", { scopeId: scope.id, name });

  // Check if secret exists
  const existing = await globalThis.services.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(eq(secrets.scopeId, scope.id), eq(secrets.name, name)))
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
      scopeId: scope.id,
      name,
      encryptedValue,
      description: description ?? null,
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
 * Delete a secret by name
 *
 * For multi-auth provider secrets, this will also delete:
 * - The associated model provider
 * - All other secrets for that provider's auth method
 */
export async function deleteSecret(
  clerkUserId: string,
  name: string,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("Secret not found");
  }

  // Check if this secret exists
  const [secret] = await globalThis.services.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.scopeId, scope.id), eq(secrets.name, name)))
    .limit(1);

  if (!secret) {
    throw notFound(`Secret "${name}" not found`);
  }

  // Check if this secret belongs to a multi-auth provider
  // Multi-auth provider secrets have type "model-provider" and
  // there's a model provider with authMethod set (not secretId)
  if (secret.type === "model-provider") {
    // Find any multi-auth provider that uses this secret
    const allProviders = await globalThis.services.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.scopeId, scope.id));

    for (const provider of allProviders) {
      if (provider.authMethod && !provider.secretId) {
        // This is a multi-auth provider
        const secretNames = getCredentialNamesForAuthMethod(
          provider.type as ModelProviderType,
          provider.authMethod,
        );

        if (secretNames && secretNames.includes(name)) {
          // This secret belongs to this multi-auth provider
          // Delete all secrets for this auth method
          await globalThis.services.db
            .delete(secrets)
            .where(
              and(
                eq(secrets.scopeId, scope.id),
                inArray(secrets.name, secretNames),
              ),
            );

          // Delete the model provider
          const wasDefault = provider.isDefault;
          const framework = getFrameworkForType(
            provider.type as ModelProviderType,
          );

          await globalThis.services.db
            .delete(modelProviders)
            .where(eq(modelProviders.id, provider.id));

          log.debug("multi-auth provider and secrets deleted", {
            scopeId: scope.id,
            type: provider.type,
            authMethod: provider.authMethod,
            secretNames,
          });

          // If it was default, assign new default for framework
          if (wasDefault) {
            const remaining = await globalThis.services.db
              .select({ id: modelProviders.id, type: modelProviders.type })
              .from(modelProviders)
              .where(eq(modelProviders.scopeId, scope.id))
              .orderBy(modelProviders.createdAt);

            const nextDefault = remaining.find(
              (p) =>
                getFrameworkForType(p.type as ModelProviderType) === framework,
            );

            if (nextDefault) {
              await globalThis.services.db
                .update(modelProviders)
                .set({ isDefault: true, updatedAt: new Date() })
                .where(eq(modelProviders.id, nextDefault.id));
            }
          }

          return;
        }
      }
    }
  }

  // Not a multi-auth provider secret, delete normally
  await globalThis.services.db.delete(secrets).where(eq(secrets.id, secret.id));

  log.debug("secret deleted", { scopeId: scope.id, name });
}
