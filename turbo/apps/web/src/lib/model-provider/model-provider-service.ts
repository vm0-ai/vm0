import { eq, and, inArray } from "drizzle-orm";
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
import { getUserScopeByClerkId } from "../scope/scope-service";

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
 * List all model providers for a user's scope
 */
export async function listModelProviders(
  clerkUserId: string,
): Promise<ModelProviderInfo[]> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return [];
  }

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
    .where(eq(modelProviders.scopeId, scope.id))
    .orderBy(modelProviders.type);

  return result.map((row) => {
    const providerType = row.type as ModelProviderType;
    const isMultiAuth = hasAuthMethods(providerType);

    // For multi-auth providers, get secret names from config
    let secretNames: string[] | undefined;
    if (isMultiAuth && row.authMethod) {
      secretNames = getSecretNamesForAuthMethod(providerType, row.authMethod);
    }

    return {
      id: row.id,
      type: providerType,
      framework: getFrameworkForType(providerType),
      secretName: row.secretName,
      authMethod: row.authMethod,
      secretNames: secretNames ?? null,
      isDefault: row.isDefault,
      selectedModel: row.selectedModel,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * Check if model-provider secret exists for a provider type
 * Note: Multi-auth providers (like aws-bedrock) are not supported by this function
 */
export async function checkSecretExists(
  clerkUserId: string,
  type: ModelProviderType,
): Promise<{ exists: boolean }> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return { exists: false };
  }

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
        eq(secrets.scopeId, scope.id),
        eq(secrets.name, secretName),
        eq(secrets.type, "model-provider"),
      ),
    )
    .limit(1);

  return { exists: !!existing };
}

/**
 * Create or update a model provider (legacy single-secret)
 * @param selectedModel For providers with model selection, the chosen model
 *
 * Note: Multi-auth providers (like aws-bedrock) should use upsertMultiAuthModelProvider instead
 * Note: User secrets and model-provider secrets are isolated by type, so no conflict detection needed
 */
export async function upsertModelProvider(
  clerkUserId: string,
  type: ModelProviderType,
  secret: string,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw badRequest(
      "You need to configure a scope first. Run `vm0 scope create` to set up your scope.",
    );
  }

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
    scopeId: scope.id,
    type,
    secretName,
  });

  // Check if model provider already exists
  const [existingProvider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scope.id), eq(modelProviders.type, type)),
    )
    .limit(1);

  if (existingProvider) {
    // Legacy providers should have secretId
    if (!existingProvider.secretId) {
      throw badRequest(
        `Provider "${type}" is missing secret reference. This is an invalid state.`,
      );
    }

    // Update existing secret value
    await globalThis.services.db
      .update(secrets)
      .set({ encryptedValue, updatedAt: new Date() })
      .where(eq(secrets.id, existingProvider.secretId));

    await globalThis.services.db
      .update(modelProviders)
      .set({
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      })
      .where(eq(modelProviders.id, existingProvider.id));

    log.debug("model provider updated", {
      providerId: existingProvider.id,
      type,
      selectedModel,
    });

    return {
      provider: {
        id: existingProvider.id,
        type,
        framework,
        secretName,
        authMethod: null, // Legacy single-secret provider
        secretNames: null,
        isDefault: existingProvider.isDefault,
        selectedModel: selectedModel ?? null,
        createdAt: existingProvider.createdAt,
        updatedAt: new Date(),
      },
      created: false,
    };
  }

  // Check if model-provider secret already exists with same name
  // Note: User secrets are independent and don't conflict
  const [existingSecret] = await globalThis.services.db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.scopeId, scope.id),
        eq(secrets.name, secretName),
        eq(secrets.type, "model-provider"),
      ),
    )
    .limit(1);

  if (existingSecret) {
    // Update existing model-provider secret
    await globalThis.services.db
      .update(secrets)
      .set({
        encryptedValue,
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existingSecret.id));

    // Check if first for framework (for default assignment)
    const allProviders = await listModelProviders(clerkUserId);
    const hasProviderForFramework = allProviders.some(
      (p) => p.framework === framework,
    );

    // Create model provider row
    const [created] = await globalThis.services.db
      .insert(modelProviders)
      .values({
        scopeId: scope.id,
        type,
        secretId: existingSecret.id,
        isDefault: !hasProviderForFramework,
        selectedModel: selectedModel ?? null,
      })
      .returning();

    if (!created) {
      throw new Error("Failed to create model provider");
    }

    log.debug("model provider created from existing secret", {
      providerId: created.id,
      type,
      selectedModel,
    });

    return {
      provider: {
        id: created.id,
        type,
        framework,
        secretName,
        authMethod: null, // Legacy single-secret provider
        secretNames: null,
        isDefault: created.isDefault,
        selectedModel: created.selectedModel,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
      created: true,
    };
  }

  // Create new model-provider secret and model provider
  // Check if first for framework
  const allProviders = await listModelProviders(clerkUserId);
  const hasProviderForFramework = allProviders.some(
    (p) => p.framework === framework,
  );

  const [newSecret] = await globalThis.services.db
    .insert(secrets)
    .values({
      scopeId: scope.id,
      name: secretName,
      encryptedValue,
      type: "model-provider",
      description: `Model provider secret for ${MODEL_PROVIDER_TYPES[type].label}`,
    })
    .returning();

  if (!newSecret) {
    throw new Error("Failed to create secret");
  }

  const [newProvider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      scopeId: scope.id,
      type,
      secretId: newSecret.id,
      isDefault: !hasProviderForFramework,
      selectedModel: selectedModel ?? null,
    })
    .returning();

  if (!newProvider) {
    throw new Error("Failed to create model provider");
  }

  log.debug("model provider created", {
    providerId: newProvider.id,
    secretId: newSecret.id,
    type,
    selectedModel,
    isDefault: newProvider.isDefault,
  });

  return {
    provider: {
      id: newProvider.id,
      type,
      framework,
      secretName,
      authMethod: null, // Legacy single-secret provider
      secretNames: null,
      isDefault: newProvider.isDefault,
      selectedModel: newProvider.selectedModel,
      createdAt: newProvider.createdAt,
      updatedAt: newProvider.updatedAt,
    },
    created: true,
  };
}

/**
 * Upsert a single secret for a multi-auth provider
 * Note: Only looks for model-provider type secrets (user secrets are independent)
 */
async function upsertMultiAuthSecret(
  scopeId: string,
  name: string,
  value: string,
  description: string,
  encryptionKey: string,
): Promise<void> {
  const encryptedValue = encryptCredentialValue(value, encryptionKey);

  // Only look for model-provider secrets (user secrets are independent)
  const [existingSecret] = await globalThis.services.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.scopeId, scopeId),
        eq(secrets.name, name),
        eq(secrets.type, "model-provider"),
      ),
    )
    .limit(1);

  if (existingSecret) {
    await globalThis.services.db
      .update(secrets)
      .set({
        encryptedValue,
        description,
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existingSecret.id));
  } else {
    await globalThis.services.db.insert(secrets).values({
      scopeId,
      name,
      encryptedValue,
      type: "model-provider",
      description,
    });
  }
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
  clerkUserId: string,
  type: ModelProviderType,
  authMethod: string,
  secretValues: Record<string, string>,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw badRequest(
      "You need to configure a scope first. Run `vm0 scope create` to set up your scope.",
    );
  }

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
    scopeId: scope.id,
    type,
    authMethod,
    secretNames: Object.keys(secretValues),
  });

  // Check if model provider already exists
  const [existingProvider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scope.id), eq(modelProviders.type, type)),
    )
    .limit(1);

  // If switching auth methods, clean up old secrets that are no longer used
  if (existingProvider && existingProvider.authMethod !== authMethod) {
    await cleanupOldAuthMethodSecrets(
      scope.id,
      type,
      existingProvider.authMethod ?? "",
      Object.keys(secretValues),
    );
  }

  // Store/update all secrets
  const secretNames = Object.keys(secretValues);
  const secretDescription = `${MODEL_PROVIDER_TYPES[type].label} secret (${authMethod})`;

  for (const [name, value] of Object.entries(secretValues)) {
    await upsertMultiAuthSecret(
      scope.id,
      name,
      value,
      secretDescription,
      encryptionKey,
    );
  }

  if (existingProvider) {
    // Update existing provider
    await globalThis.services.db
      .update(modelProviders)
      .set({
        authMethod,
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      })
      .where(eq(modelProviders.id, existingProvider.id));

    log.debug("multi-auth model provider updated", {
      providerId: existingProvider.id,
      type,
      authMethod,
      selectedModel,
    });

    return {
      provider: {
        id: existingProvider.id,
        type,
        framework,
        secretName: null,
        authMethod,
        secretNames,
        isDefault: existingProvider.isDefault,
        selectedModel: selectedModel ?? null,
        createdAt: existingProvider.createdAt,
        updatedAt: new Date(),
      },
      created: false,
    };
  }

  // Check if first for framework (for default assignment)
  const allProviders = await listModelProviders(clerkUserId);
  const hasProviderForFramework = allProviders.some(
    (p) => p.framework === framework,
  );

  // Create new provider (no secretId for multi-auth)
  const [newProvider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      scopeId: scope.id,
      type,
      authMethod,
      isDefault: !hasProviderForFramework,
      selectedModel: selectedModel ?? null,
    })
    .returning();

  if (!newProvider) {
    throw new Error("Failed to create model provider");
  }

  log.debug("multi-auth model provider created", {
    providerId: newProvider.id,
    type,
    authMethod,
    selectedModel,
    isDefault: newProvider.isDefault,
  });

  return {
    provider: {
      id: newProvider.id,
      type,
      framework,
      secretName: null,
      authMethod,
      secretNames,
      isDefault: newProvider.isDefault,
      selectedModel: newProvider.selectedModel,
      createdAt: newProvider.createdAt,
      updatedAt: newProvider.updatedAt,
    },
    created: true,
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
  clerkUserId: string,
  type: ModelProviderType,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("Model provider not found");
  }

  const framework = getFrameworkForType(type);

  // Find the model provider
  const [provider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scope.id), eq(modelProviders.type, type)),
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
              eq(secrets.scopeId, scope.id),
              inArray(secrets.name, secretNames),
            ),
          );
        log.debug("multi-auth secrets deleted", {
          scopeId: scope.id,
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

  log.debug("model provider deleted", { scopeId: scope.id, type });

  // If it was default, assign new default for framework
  if (wasDefault) {
    const remaining = await globalThis.services.db
      .select({ id: modelProviders.id, type: modelProviders.type })
      .from(modelProviders)
      .where(eq(modelProviders.scopeId, scope.id))
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
  clerkUserId: string,
  type: ModelProviderType,
): Promise<ModelProviderInfo> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("Model provider not found");
  }

  const framework = getFrameworkForType(type);
  // For multi-auth providers, secretName will be null in response
  const secretName = getSecretNameForType(type) ?? null;

  // Find the target provider
  const [target] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scope.id), eq(modelProviders.type, type)),
    )
    .limit(1);

  if (!target) {
    throw notFound(`Model provider "${type}" not found`);
  }

  if (target.isDefault) {
    return {
      id: target.id,
      type,
      framework,
      secretName,
      authMethod: target.authMethod ?? null,
      secretNames: target.authMethod
        ? (getSecretNamesForAuthMethod(type, target.authMethod) ?? null)
        : null,
      isDefault: true,
      selectedModel: target.selectedModel,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };
  }

  // Get all providers for the same framework to clear their defaults
  const allProviders = await globalThis.services.db
    .select({ id: modelProviders.id, type: modelProviders.type })
    .from(modelProviders)
    .where(eq(modelProviders.scopeId, scope.id));

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

  return {
    id: target.id,
    type,
    framework,
    secretName,
    authMethod: target.authMethod ?? null,
    secretNames: target.authMethod
      ? (getSecretNamesForAuthMethod(type, target.authMethod) ?? null)
      : null,
    isDefault: true,
    selectedModel: target.selectedModel,
    createdAt: target.createdAt,
    updatedAt: new Date(),
  };
}

/**
 * Update model selection for an existing provider (keeps secret unchanged)
 */
export async function updateModelProviderModel(
  clerkUserId: string,
  type: ModelProviderType,
  selectedModel?: string,
): Promise<ModelProviderInfo> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("Model provider not found");
  }

  const framework = getFrameworkForType(type);
  // For multi-auth providers, secretName will be null in response
  const secretName = getSecretNameForType(type) ?? null;

  // Find the model provider
  const [provider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scope.id), eq(modelProviders.type, type)),
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

  return {
    id: provider.id,
    type,
    framework,
    secretName,
    authMethod: provider.authMethod ?? null,
    secretNames: provider.authMethod
      ? (getSecretNamesForAuthMethod(type, provider.authMethod) ?? null)
      : null,
    isDefault: provider.isDefault,
    selectedModel: selectedModel ?? null,
    createdAt: provider.createdAt,
    updatedAt: new Date(),
  };
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

  const providerType = defaultProvider.type as ModelProviderType;
  const isMultiAuth = hasAuthMethods(providerType);

  // For multi-auth providers, get secret names from config
  let secretNames: string[] | undefined;
  if (isMultiAuth && defaultProvider.authMethod) {
    secretNames = getSecretNamesForAuthMethod(
      providerType,
      defaultProvider.authMethod,
    );
  }

  return {
    id: defaultProvider.id,
    type: providerType,
    framework,
    secretName: defaultProvider.secretName,
    authMethod: defaultProvider.authMethod ?? null,
    secretNames: secretNames ?? null,
    isDefault: defaultProvider.isDefault,
    selectedModel: defaultProvider.selectedModel,
    createdAt: defaultProvider.createdAt,
    updatedAt: defaultProvider.updatedAt,
  };
}
