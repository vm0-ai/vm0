import { eq, and, ne, inArray, sql, notExists } from "drizzle-orm";
import {
  MODEL_PROVIDER_TYPES,
  getFrameworkForType,
  getSecretNameForType,
  hasAuthMethods,
  getAuthMethodsForType,
  getSecretsForAuthMethod,
  getSecretNamesForAuthMethod,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { modelProviders } from "../../db/schema/model-provider";
import { secrets } from "../../db/schema/secret";
import { encryptCredentialValue } from "../crypto";
import { badRequest, notFound } from "../errors";
import { logger } from "../logger";

const log = logger("service:model-provider");

interface ModelProviderInfo {
  id: string;
  type: ModelProviderType;
  framework: ModelProviderFramework;
  secretName: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Build a ModelProviderInfo from raw fields.
 * Derives framework from type, and secretNames from authMethod when not explicitly provided.
 */
function toModelProviderInfo(params: {
  id: string;
  type: ModelProviderType;
  secretName?: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ModelProviderInfo {
  const authMethod = params.authMethod ?? null;
  const secretNames =
    params.secretNames !== undefined
      ? params.secretNames
      : authMethod
        ? (getSecretNamesForAuthMethod(params.type, authMethod) ?? null)
        : null;

  return {
    id: params.id,
    type: params.type,
    framework: getFrameworkForType(params.type),
    secretName: params.secretName ?? null,
    authMethod,
    secretNames,
    isDefault: params.isDefault,
    selectedModel: params.selectedModel,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

/**
 * Get all provider types that belong to a given framework.
 */
function getTypesForFramework(framework: ModelProviderFramework): string[] {
  return Object.keys(MODEL_PROVIDER_TYPES).filter(
    (t) => getFrameworkForType(t as ModelProviderType) === framework,
  );
}

/**
 * Atomically assign isDefault=true to a provider, but only if no other provider
 * for the same framework already has isDefault=true.
 *
 * Uses a single UPDATE with NOT EXISTS subquery to prevent the race condition
 * where two concurrent inserts both set isDefault=true.
 *
 * @returns true if isDefault was set, false if another default already exists
 */
async function assignDefaultIfFirst(
  scopeId: string,
  providerId: string,
  framework: ModelProviderFramework,
): Promise<boolean> {
  const frameworkTypes = getTypesForFramework(framework);

  const result = await globalThis.services.db
    .update(modelProviders)
    .set({ isDefault: true })
    .where(
      and(
        eq(modelProviders.id, providerId),
        notExists(
          globalThis.services.db
            .select({ id: sql`1` })
            .from(modelProviders)
            .where(
              and(
                eq(modelProviders.scopeId, scopeId),
                eq(modelProviders.isDefault, true),
                ne(modelProviders.id, providerId),
                inArray(modelProviders.type, frameworkTypes),
              ),
            ),
        ),
      ),
    );

  return (result.rowCount ?? 0) > 0;
}

/**
 * List all model providers for a scope
 */
export async function listModelProviders(
  scopeId: string,
): Promise<ModelProviderInfo[]> {
  // Use leftJoin to include multi-auth providers that don't have secretId
  const result = await globalThis.services.db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      isDefault: modelProviders.isDefault,
      selectedModel: modelProviders.selectedModel,
      authMethod: modelProviders.authMethod,
      secretName: secrets.name,
      createdAt: modelProviders.createdAt,
      updatedAt: modelProviders.updatedAt,
    })
    .from(modelProviders)
    .leftJoin(secrets, eq(modelProviders.secretId, secrets.id))
    .where(eq(modelProviders.scopeId, scopeId))
    .orderBy(modelProviders.type);

  return result.map((row) =>
    toModelProviderInfo({
      id: row.id,
      type: row.type as ModelProviderType,
      secretName: row.secretName,
      authMethod: row.authMethod,
      isDefault: row.isDefault,
      selectedModel: row.selectedModel,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  );
}

/**
 * Check if model-provider secret exists for a provider type
 * Note: Multi-auth providers (like aws-bedrock) are not supported by this function
 */
export async function checkSecretExists(
  scopeId: string,
  type: ModelProviderType,
): Promise<{ exists: boolean }> {
  // Multi-auth providers don't have a single secretName
  if (hasAuthMethods(type)) {
    return { exists: false };
  }

  const secretName = getSecretNameForType(type);
  if (!secretName) {
    return { exists: false };
  }

  // Only check for model-provider type secrets (user secrets are independent)
  const [existing] = await globalThis.services.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.scopeId, scopeId),
        eq(secrets.name, secretName),
        eq(secrets.type, "model-provider"),
      ),
    )
    .limit(1);

  return { exists: !!existing };
}

/**
 * Create or update a model provider (legacy single-secret)
 * Uses atomic INSERT ... ON CONFLICT DO UPDATE to handle concurrent requests safely.
 *
 * @param selectedModel For providers with model selection, the chosen model
 *
 * Note: Multi-auth providers (like aws-bedrock) should use upsertMultiAuthModelProvider instead
 * Note: User secrets and model-provider secrets are isolated by type, so no conflict detection needed
 */
export async function upsertModelProvider(
  scopeId: string,
  userId: string,
  type: ModelProviderType,
  secret: string,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  // Multi-auth providers need different handling
  if (hasAuthMethods(type)) {
    throw badRequest(
      `Provider "${type}" requires multiple secrets. Use the multi-auth API instead.`,
    );
  }

  const secretName = getSecretNameForType(type);
  if (!secretName) {
    throw badRequest(`Provider "${type}" does not have a secret name`);
  }
  const framework = getFrameworkForType(type);
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(secret, encryptionKey);

  log.debug("upserting model provider", {
    scopeId,
    type,
    secretName,
  });

  // Pre-check: does a provider for this type already exist?
  // Race window is benign — worst case, two concurrent creates both return created:true (cosmetic only)
  const [existingProvider] = await globalThis.services.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scopeId), eq(modelProviders.type, type)),
    )
    .limit(1);

  // Atomic secret upsert — handles concurrent requests safely
  const [upsertedSecret] = await globalThis.services.db
    .insert(secrets)
    .values({
      scopeId,
      name: secretName,
      encryptedValue,
      type: "model-provider",
      description: `Model provider secret for ${MODEL_PROVIDER_TYPES[type].label}`,
    })
    .onConflictDoUpdate({
      target: [secrets.scopeId, secrets.name, secrets.type],
      set: { encryptedValue, updatedAt: new Date() },
    })
    .returning();

  // Atomic model provider upsert — handles concurrent requests safely
  const [provider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      scopeId,
      type,
      userId,
      secretId: upsertedSecret!.id,
      isDefault: false,
      selectedModel: selectedModel ?? null,
    })
    .onConflictDoUpdate({
      target: [modelProviders.scopeId, modelProviders.type],
      set: {
        secretId: upsertedSecret!.id,
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const wasCreated = !existingProvider;

  // Assign default if this is a new provider and no other default exists for the framework
  if (wasCreated) {
    const isDefault = await assignDefaultIfFirst(
      scopeId,
      provider!.id,
      framework,
    );
    if (isDefault) {
      provider!.isDefault = true;
    }
  }

  log.debug(wasCreated ? "model provider created" : "model provider updated", {
    providerId: provider!.id,
    type,
    selectedModel,
    isDefault: provider!.isDefault,
  });

  return {
    provider: toModelProviderInfo({
      id: provider!.id,
      type,
      secretName,
      isDefault: provider!.isDefault,
      selectedModel: provider!.selectedModel,
      createdAt: provider!.createdAt,
      updatedAt: provider!.updatedAt,
    }),
    created: wasCreated,
  };
}

/**
 * Upsert a single secret for a multi-auth provider.
 * Uses atomic INSERT ... ON CONFLICT DO UPDATE to handle concurrent requests safely.
 * Note: Only targets model-provider type secrets (user secrets are independent)
 */
async function upsertMultiAuthSecret(
  scopeId: string,
  name: string,
  value: string,
  description: string,
  encryptionKey: string,
): Promise<void> {
  const encryptedValue = encryptCredentialValue(value, encryptionKey);

  await globalThis.services.db
    .insert(secrets)
    .values({
      scopeId,
      name,
      encryptedValue,
      type: "model-provider",
      description,
    })
    .onConflictDoUpdate({
      target: [secrets.scopeId, secrets.name, secrets.type],
      set: { encryptedValue, description, updatedAt: new Date() },
    });
}

/**
 * Clean up old secrets when switching auth methods
 */
async function cleanupOldAuthMethodSecrets(
  scopeId: string,
  type: ModelProviderType,
  oldAuthMethod: string,
  newSecretNames: string[],
): Promise<void> {
  const oldSecretNames = getSecretNamesForAuthMethod(type, oldAuthMethod);

  // Find secrets that exist in old auth method but not in new
  const secretsToDelete = oldSecretNames?.filter(
    (name) => !newSecretNames.includes(name),
  );

  if (secretsToDelete && secretsToDelete.length > 0) {
    await globalThis.services.db
      .delete(secrets)
      .where(
        and(
          eq(secrets.scopeId, scopeId),
          inArray(secrets.name, secretsToDelete),
        ),
      );
    log.debug("old auth method secrets cleaned up", {
      scopeId,
      type,
      oldAuthMethod,
      deletedSecrets: secretsToDelete,
    });
  }
}

/**
 * Create or update a multi-auth model provider (like aws-bedrock)
 * @param authMethod The auth method to use (e.g., "api-key", "access-keys")
 * @param secretValues Map of secret names to their values
 * @param selectedModel Optional selected model
 */
export async function upsertMultiAuthModelProvider(
  scopeId: string,
  userId: string,
  type: ModelProviderType,
  authMethod: string,
  secretValues: Record<string, string>,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  // Verify this is a multi-auth provider
  if (!hasAuthMethods(type)) {
    throw badRequest(
      `Provider "${type}" is a legacy single-secret provider. Use the standard upsert API.`,
    );
  }

  // Validate auth method
  const authMethods = getAuthMethodsForType(type);
  if (!authMethods || !(authMethod in authMethods)) {
    const validMethods = authMethods ? Object.keys(authMethods).join(", ") : "";
    throw badRequest(
      `Invalid auth method "${authMethod}" for provider "${type}". Valid methods: ${validMethods}`,
    );
  }

  // Validate required secrets
  const secretsConfig = getSecretsForAuthMethod(type, authMethod);
  if (!secretsConfig) {
    throw badRequest(`No secrets config found for auth method "${authMethod}"`);
  }

  const missingRequired: string[] = [];
  for (const [name, config] of Object.entries(secretsConfig)) {
    if (config.required && !secretValues[name]) {
      missingRequired.push(name);
    }
  }

  if (missingRequired.length > 0) {
    throw badRequest(
      `Missing required secrets for ${authMethod}: ${missingRequired.join(", ")}`,
    );
  }

  const framework = getFrameworkForType(type);
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

  log.debug("upserting multi-auth model provider", {
    scopeId,
    type,
    authMethod,
    secretNames: Object.keys(secretValues),
  });

  // Check if model provider already exists (needed for auth method switch cleanup)
  const [existingProvider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scopeId), eq(modelProviders.type, type)),
    )
    .limit(1);

  // If switching auth methods, clean up old secrets that are no longer used
  if (existingProvider && existingProvider.authMethod !== authMethod) {
    await cleanupOldAuthMethodSecrets(
      scopeId,
      type,
      existingProvider.authMethod ?? "",
      Object.keys(secretValues),
    );
  }

  // Store/update all secrets atomically
  const secretNames = Object.keys(secretValues);
  const secretDescription = `${MODEL_PROVIDER_TYPES[type].label} secret (${authMethod})`;

  for (const [name, value] of Object.entries(secretValues)) {
    await upsertMultiAuthSecret(
      scopeId,
      name,
      value,
      secretDescription,
      encryptionKey,
    );
  }

  // Atomic model provider upsert — handles concurrent requests safely
  const [provider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      scopeId,
      type,
      userId,
      authMethod,
      isDefault: false,
      selectedModel: selectedModel ?? null,
    })
    .onConflictDoUpdate({
      target: [modelProviders.scopeId, modelProviders.type],
      set: {
        authMethod,
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const wasCreated = !existingProvider;

  // Assign default if this is a new provider and no other default exists for the framework
  if (wasCreated) {
    const isDefault = await assignDefaultIfFirst(
      scopeId,
      provider!.id,
      framework,
    );
    if (isDefault) {
      provider!.isDefault = true;
    }
  }

  log.debug(
    wasCreated
      ? "multi-auth model provider created"
      : "multi-auth model provider updated",
    {
      providerId: provider!.id,
      type,
      authMethod,
      selectedModel,
      isDefault: provider!.isDefault,
    },
  );

  return {
    provider: toModelProviderInfo({
      id: provider!.id,
      type,
      authMethod,
      secretNames,
      isDefault: provider!.isDefault,
      selectedModel: provider!.selectedModel,
      createdAt: provider!.createdAt,
      updatedAt: provider!.updatedAt,
    }),
    created: wasCreated,
  };
}

/**
 * @deprecated Secret conversion is no longer needed since user and model-provider secrets
 * are now isolated by type. Simply configure your model provider directly.
 */
export async function convertSecretToModelProvider(): Promise<never> {
  throw badRequest(
    "Secret conversion is no longer needed. User secrets and model provider secrets are now isolated by type. " +
      "Simply configure your model provider directly with `vm0 model-provider setup`.",
  );
}

/**
 * Delete a model provider and its secret
 */
export async function deleteModelProvider(
  scopeId: string,
  type: ModelProviderType,
): Promise<void> {
  const framework = getFrameworkForType(type);

  // Find the model provider
  const [provider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scopeId), eq(modelProviders.type, type)),
    )
    .limit(1);

  if (!provider) {
    throw notFound(`Model provider "${type}" not found`);
  }

  const wasDefault = provider.isDefault;
  const secretId = provider.secretId;

  // Delete secret (cascades to model_provider) - only for legacy providers
  if (secretId) {
    await globalThis.services.db
      .delete(secrets)
      .where(eq(secrets.id, secretId));
  } else {
    // Multi-auth providers: delete all associated secrets
    if (provider.authMethod) {
      const secretNames = getSecretNamesForAuthMethod(
        type,
        provider.authMethod,
      );
      if (secretNames && secretNames.length > 0) {
        await globalThis.services.db
          .delete(secrets)
          .where(
            and(
              eq(secrets.scopeId, scopeId),
              inArray(secrets.name, secretNames),
            ),
          );
        log.debug("multi-auth secrets deleted", {
          scopeId,
          type,
          secretNames,
        });
      }
    }
    // Delete the model_provider
    await globalThis.services.db
      .delete(modelProviders)
      .where(eq(modelProviders.id, provider.id));
  }

  log.debug("model provider deleted", { scopeId, type });

  // If it was default, assign new default for framework
  if (wasDefault) {
    const remaining = await globalThis.services.db
      .select({ id: modelProviders.id, type: modelProviders.type })
      .from(modelProviders)
      .where(eq(modelProviders.scopeId, scopeId))
      .orderBy(modelProviders.createdAt);

    const nextDefault = remaining.find(
      (p) => getFrameworkForType(p.type as ModelProviderType) === framework,
    );

    if (nextDefault) {
      await globalThis.services.db
        .update(modelProviders)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(modelProviders.id, nextDefault.id));

      log.debug("new default assigned", {
        framework,
        newDefaultType: nextDefault.type,
      });
    }
  }
}

/**
 * Set a model provider as default for its framework
 */
export async function setModelProviderDefault(
  scopeId: string,
  type: ModelProviderType,
): Promise<ModelProviderInfo> {
  const framework = getFrameworkForType(type);
  // For multi-auth providers, secretName will be null in response
  const secretName = getSecretNameForType(type) ?? null;

  // Find the target provider
  const [target] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scopeId), eq(modelProviders.type, type)),
    )
    .limit(1);

  if (!target) {
    throw notFound(`Model provider "${type}" not found`);
  }

  if (target.isDefault) {
    return toModelProviderInfo({
      id: target.id,
      type,
      secretName,
      authMethod: target.authMethod,
      isDefault: true,
      selectedModel: target.selectedModel,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    });
  }

  // Get all providers for the same framework to clear their defaults
  const allProviders = await globalThis.services.db
    .select({ id: modelProviders.id, type: modelProviders.type })
    .from(modelProviders)
    .where(eq(modelProviders.scopeId, scopeId));

  const sameFrameworkIds = allProviders
    .filter(
      (p) => getFrameworkForType(p.type as ModelProviderType) === framework,
    )
    .map((p) => p.id);

  // Use transaction to ensure atomicity
  await globalThis.services.db.transaction(async (tx) => {
    // Clear all defaults for this framework
    if (sameFrameworkIds.length > 0) {
      await tx
        .update(modelProviders)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(inArray(modelProviders.id, sameFrameworkIds));
    }

    // Set new default
    await tx
      .update(modelProviders)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(modelProviders.id, target.id));
  });

  log.debug("model provider set as default", { type, framework });

  return toModelProviderInfo({
    id: target.id,
    type,
    secretName,
    authMethod: target.authMethod,
    isDefault: true,
    selectedModel: target.selectedModel,
    createdAt: target.createdAt,
    updatedAt: new Date(),
  });
}

/**
 * Update model selection for an existing provider (keeps secret unchanged)
 */
export async function updateModelProviderModel(
  scopeId: string,
  type: ModelProviderType,
  selectedModel?: string,
): Promise<ModelProviderInfo> {
  // For multi-auth providers, secretName will be null in response
  const secretName = getSecretNameForType(type) ?? null;

  // Find the model provider
  const [provider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scopeId), eq(modelProviders.type, type)),
    )
    .limit(1);

  if (!provider) {
    throw notFound(`Model provider "${type}" not found`);
  }

  // Update only the model selection
  await globalThis.services.db
    .update(modelProviders)
    .set({
      selectedModel: selectedModel ?? null,
      updatedAt: new Date(),
    })
    .where(eq(modelProviders.id, provider.id));

  log.debug("model provider model updated", {
    providerId: provider.id,
    type,
    selectedModel,
  });

  return toModelProviderInfo({
    id: provider.id,
    type,
    secretName,
    authMethod: provider.authMethod,
    isDefault: provider.isDefault,
    selectedModel: selectedModel ?? null,
    createdAt: provider.createdAt,
    updatedAt: new Date(),
  });
}

/**
 * Get the default model provider for a framework
 * Supports both legacy single-secret and multi-auth providers
 */
export async function getDefaultModelProvider(
  scopeId: string,
  framework: ModelProviderFramework,
): Promise<ModelProviderInfo | null> {
  // Use leftJoin to include multi-auth providers that don't have secretId
  const allProviders = await globalThis.services.db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      isDefault: modelProviders.isDefault,
      selectedModel: modelProviders.selectedModel,
      authMethod: modelProviders.authMethod,
      secretName: secrets.name,
      createdAt: modelProviders.createdAt,
      updatedAt: modelProviders.updatedAt,
    })
    .from(modelProviders)
    .leftJoin(secrets, eq(modelProviders.secretId, secrets.id))
    .where(eq(modelProviders.scopeId, scopeId));

  const defaultProvider = allProviders.find(
    (p) =>
      p.isDefault &&
      getFrameworkForType(p.type as ModelProviderType) === framework,
  );

  if (!defaultProvider) {
    return null;
  }

  return toModelProviderInfo({
    id: defaultProvider.id,
    type: defaultProvider.type as ModelProviderType,
    secretName: defaultProvider.secretName,
    authMethod: defaultProvider.authMethod,
    isDefault: defaultProvider.isDefault,
    selectedModel: defaultProvider.selectedModel,
    createdAt: defaultProvider.createdAt,
    updatedAt: defaultProvider.updatedAt,
  });
}
