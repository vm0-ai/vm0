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
} from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { encryptSecretValue } from "../../shared/crypto";
import { badRequest, notFound } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import type { Database } from "../../../types/global";

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
 *
 * Accepts `string` rather than `ModelProviderFramework` so callers that derive
 * the framework from a compose document (codex, claude-code, …) can filter
 * without first widening the registry's enum.
 */
function getTypesForFramework(framework: string): string[] {
  return Object.keys(MODEL_PROVIDER_TYPES).filter((t) => {
    return getFrameworkForType(t as ModelProviderType) === framework;
  });
}

/**
 * Atomically assign isDefault=true to a provider, but only if no other provider
 * already has isDefault=true for the same (orgId, userId) scope.
 *
 * Uses a single UPDATE with NOT EXISTS subquery to prevent the race condition
 * where two concurrent inserts both set isDefault=true.
 *
 * Workspace-scoped (per orgId + userId), regardless of framework — paired with
 * the partial unique index `idx_model_providers_one_default_per_user`.
 *
 * @returns true if isDefault was set, false if another default already exists
 */
async function assignDefaultIfFirst(
  orgId: string,
  userId: string,
  providerId: string,
): Promise<boolean> {
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
                eq(modelProviders.orgId, orgId),
                eq(modelProviders.userId, userId),
                eq(modelProviders.isDefault, true),
                ne(modelProviders.id, providerId),
              ),
            ),
        ),
      ),
    );

  return (result.rowCount ?? 0) > 0;
}

/**
 * List all model providers for an org
 */
async function listModelProviders(
  orgId: string,
  userId: string,
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
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
    )
    .orderBy(modelProviders.type);

  return result.map((row) => {
    return toModelProviderInfo({
      id: row.id,
      type: row.type as ModelProviderType,
      secretName: row.secretName,
      authMethod: row.authMethod,
      isDefault: row.isDefault,
      selectedModel: row.selectedModel,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });
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
async function upsertModelProvider(
  orgId: string,
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
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptSecretValue(secret, encryptionKey);

  log.debug("upserting model provider", {
    orgId,
    type,
    secretName,
  });

  // Pre-check: does a provider for this type already exist?
  // Race window is benign — worst case, two concurrent creates both return created:true (cosmetic only)
  const [existingProvider] = await globalThis.services.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  // Atomic secret upsert — handles concurrent requests safely
  const [upsertedSecret] = await globalThis.services.db
    .insert(secrets)
    .values({
      userId,
      name: secretName,
      encryptedValue,
      type: "model-provider",
      description: `Model provider secret for ${MODEL_PROVIDER_TYPES[type].label}`,
      orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: { encryptedValue, updatedAt: new Date() },
    })
    .returning();

  // Atomic model provider upsert — handles concurrent requests safely
  const [provider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId,
      secretId: upsertedSecret!.id,
      isDefault: false,
      selectedModel: selectedModel ?? null,
      orgId,
    })
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: {
        secretId: upsertedSecret!.id,
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const wasCreated = !existingProvider;

  // Assign default if no other default exists for the workspace (on create or update)
  if (!provider!.isDefault) {
    const isDefault = await assignDefaultIfFirst(orgId, userId, provider!.id);
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
  orgId: string,
  userId: string,
  name: string,
  value: string,
  description: string,
  encryptionKey: string,
): Promise<void> {
  const encryptedValue = encryptSecretValue(value, encryptionKey);

  await globalThis.services.db
    .insert(secrets)
    .values({
      userId,
      name,
      encryptedValue,
      type: "model-provider",
      description,
      orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: { encryptedValue, description, updatedAt: new Date() },
    });
}

/**
 * Clean up old secrets when switching auth methods
 */
async function cleanupOldAuthMethodSecrets(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  oldAuthMethod: string,
  newSecretNames: string[],
): Promise<void> {
  const oldSecretNames = getSecretNamesForAuthMethod(type, oldAuthMethod);

  // Find secrets that exist in old auth method but not in new
  const secretsToDelete = oldSecretNames?.filter((name) => {
    return !newSecretNames.includes(name);
  });

  if (secretsToDelete && secretsToDelete.length > 0) {
    await globalThis.services.db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          inArray(secrets.name, secretsToDelete),
        ),
      );
    log.debug("old auth method secrets cleaned up", {
      orgId,
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
async function upsertMultiAuthModelProvider(
  orgId: string,
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

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

  log.debug("upserting multi-auth model provider", {
    orgId,
    type,
    authMethod,
    secretNames: Object.keys(secretValues),
  });

  // Check if model provider already exists (needed for auth method switch cleanup)
  const [existingProvider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  // If switching auth methods, clean up old secrets that are no longer used
  if (existingProvider && existingProvider.authMethod !== authMethod) {
    await cleanupOldAuthMethodSecrets(
      orgId,
      userId,
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
      orgId,
      userId,
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
      type,
      userId,
      authMethod,
      isDefault: false,
      selectedModel: selectedModel ?? null,
      orgId,
    })
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: {
        authMethod,
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const wasCreated = !existingProvider;

  // Assign default if no other default exists for the workspace (on create or update)
  if (!provider!.isDefault) {
    const isDefault = await assignDefaultIfFirst(orgId, userId, provider!.id);
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
 * Create or update a model provider that requires no secret (e.g., vm0 managed provider).
 * Inserts model_providers with secretId = NULL and authMethod = NULL.
 */
async function upsertNoSecretModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  log.debug("upserting no-secret model provider", {
    orgId,
    type,
    selectedModel,
  });

  // Pre-check: does a provider for this type already exist?
  const [existingProvider] = await globalThis.services.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  // Atomic model provider upsert
  const [provider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId,
      isDefault: false,
      selectedModel: selectedModel ?? null,
      orgId,
    })
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: {
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const wasCreated = !existingProvider;

  // Assign default if no other default exists for the workspace
  if (!provider!.isDefault) {
    const isDefault = await assignDefaultIfFirst(orgId, userId, provider!.id);
    if (isDefault) {
      provider!.isDefault = true;
    }
  }

  log.debug(
    wasCreated
      ? "no-secret model provider created"
      : "no-secret model provider updated",
    {
      providerId: provider!.id,
      type,
      selectedModel,
      isDefault: provider!.isDefault,
    },
  );

  return {
    provider: toModelProviderInfo({
      id: provider!.id,
      type,
      isDefault: provider!.isDefault,
      selectedModel: provider!.selectedModel,
      createdAt: provider!.createdAt,
      updatedAt: provider!.updatedAt,
    }),
    created: wasCreated,
  };
}

/**
 * Delete a model provider and its secret
 */
async function deleteModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
): Promise<void> {
  // Find the model provider
  const [provider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
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
              eq(secrets.orgId, orgId),
              eq(secrets.userId, userId),
              inArray(secrets.name, secretNames),
            ),
          );
        log.debug("multi-auth secrets deleted", {
          orgId,
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

  log.debug("model provider deleted", { orgId, type });

  // If it was the workspace default, promote the earliest remaining provider
  // (regardless of framework — workspace has at most one default).
  if (wasDefault) {
    const [nextDefault] = await globalThis.services.db
      .select({ id: modelProviders.id, type: modelProviders.type })
      .from(modelProviders)
      .where(
        and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
      )
      .orderBy(modelProviders.createdAt)
      .limit(1);

    if (nextDefault) {
      await globalThis.services.db
        .update(modelProviders)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(modelProviders.id, nextDefault.id));

      log.debug("new default assigned", {
        newDefaultType: nextDefault.type,
      });
    }
  }
}

/**
 * Set a model provider as the workspace default. Workspace-scoped — clears any
 * existing default for the (orgId, userId) regardless of framework, paired with
 * the partial unique index `idx_model_providers_one_default_per_user`.
 */
async function setModelProviderDefault(
  orgId: string,
  userId: string,
  type: ModelProviderType,
): Promise<ModelProviderInfo> {
  // For multi-auth providers, secretName will be null in response
  const secretName = getSecretNameForType(type) ?? null;

  // Find the target provider
  const [target] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
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

  // Clear the existing default (if any) and set the new one in a single tx so
  // the partial unique index never sees a dual-default state.
  await globalThis.services.db.transaction(async (tx) => {
    await tx
      .update(modelProviders)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, userId),
          eq(modelProviders.isDefault, true),
          ne(modelProviders.id, target.id),
        ),
      );

    await tx
      .update(modelProviders)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(modelProviders.id, target.id));
  });

  log.debug("model provider set as default", { type });

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
async function updateModelProviderModel(
  orgId: string,
  userId: string,
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
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
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
async function getDefaultModelProvider(
  orgId: string,
  userId: string,
  framework: string,
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
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
    );

  const defaultProvider = allProviders.find((p) => {
    return (
      p.isDefault &&
      p.type in MODEL_PROVIDER_TYPES &&
      getFrameworkForType(p.type as ModelProviderType) === framework
    );
  });

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

/**
 * Get the default model provider regardless of framework. Returns the first
 * `isDefault: true` provider for the (orgId, userId) scope. Used as the
 * cross-framework fallback in admission (see Epic #11520 — provider's
 * framework wins over compose's once admission resolves a provider).
 */
async function getAnyDefaultModelProvider(
  orgId: string,
  userId: string,
): Promise<ModelProviderInfo | null> {
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
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
    );

  const defaultProvider = allProviders.find((p) => {
    return p.isDefault && p.type in MODEL_PROVIDER_TYPES;
  });

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

// ============================================================================
// Org-Level Model Provider Functions
//
// These delegate to the user-level functions using ORG_SENTINEL_USER_ID.
// The sentinel userId ensures org and user providers are fully isolated.
// ============================================================================

/**
 * List all org-level model providers
 */
export function listOrgModelProviders(
  orgId: string,
): Promise<ModelProviderInfo[]> {
  return listModelProviders(orgId, ORG_SENTINEL_USER_ID);
}

/**
 * Create or update an org-level model provider (single-secret).
 * Uses ORG_SENTINEL_USER_ID for org-scoped storage.
 */
export function upsertOrgModelProvider(
  orgId: string,
  type: ModelProviderType,
  secret: string,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertModelProvider(
    orgId,
    ORG_SENTINEL_USER_ID,
    type,
    secret,
    selectedModel,
  );
}

/**
 * Create or update an org-level multi-auth model provider (e.g., aws-bedrock).
 * Uses ORG_SENTINEL_USER_ID for org-scoped storage.
 */
export function upsertOrgMultiAuthModelProvider(
  orgId: string,
  type: ModelProviderType,
  authMethod: string,
  secretValues: Record<string, string>,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertMultiAuthModelProvider(
    orgId,
    ORG_SENTINEL_USER_ID,
    type,
    authMethod,
    secretValues,
    selectedModel,
  );
}

/**
 * Create or update an org-level no-secret model provider (e.g., vm0).
 * Uses ORG_SENTINEL_USER_ID for org-scoped storage.
 */
export function upsertOrgNoSecretModelProvider(
  orgId: string,
  type: ModelProviderType,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertNoSecretModelProvider(
    orgId,
    ORG_SENTINEL_USER_ID,
    type,
    selectedModel,
  );
}

/**
 * Delete an org-level model provider and its secrets
 */
export function deleteOrgModelProvider(
  orgId: string,
  type: ModelProviderType,
): Promise<void> {
  return deleteModelProvider(orgId, ORG_SENTINEL_USER_ID, type);
}

/**
 * Set an org-level model provider as the workspace default
 */
export function setOrgModelProviderDefault(
  orgId: string,
  type: ModelProviderType,
): Promise<ModelProviderInfo> {
  return setModelProviderDefault(orgId, ORG_SENTINEL_USER_ID, type);
}

/**
 * Update model selection for an org-level provider
 */
export function updateOrgModelProviderModel(
  orgId: string,
  type: ModelProviderType,
  selectedModel?: string,
): Promise<ModelProviderInfo> {
  return updateModelProviderModel(
    orgId,
    ORG_SENTINEL_USER_ID,
    type,
    selectedModel,
  );
}

/**
 * Get the org-level default model provider for a framework.
 *
 * `framework` accepts any string so non-claude-code frameworks (e.g. codex)
 * can resolve their own default without widening the registry's enum.
 * Unknown frameworks naturally return null because no registry type matches.
 */
export function getOrgDefaultModelProvider(
  orgId: string,
  framework: string,
): Promise<ModelProviderInfo | null> {
  return getDefaultModelProvider(orgId, ORG_SENTINEL_USER_ID, framework);
}

/**
 * Get the org-level default model provider type for run-policy checks.
 *
 * Filters by framework so a claude-code default does not satisfy a codex run
 * (and vice versa) — without this filter, admission checks would pass for
 * cross-framework configurations and fail later at provider-resolution time
 * with a worse error.
 *
 * Accepts a db handle so callers inside queue-drain transactions can keep
 * the read in the same boundary.
 */
export async function getOrgDefaultModelProviderType(
  orgId: string,
  framework: string,
  db: Database = globalThis.services.db,
): Promise<string | null> {
  const frameworkTypes = getTypesForFramework(framework);
  if (frameworkTypes.length === 0) {
    return null;
  }

  const [row] = await db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
        inArray(modelProviders.type, frameworkTypes),
      ),
    )
    .limit(1);

  return row?.type ?? null;
}

/**
 * Get the org-level default model provider regardless of framework.
 *
 * Used as the cross-framework fallback by admission (Stage B) when
 * `getOrgDefaultModelProvider(orgId, composeFramework)` returns null. Per
 * Epic #11520, the provider's framework wins; admission accepts any default
 * and downstream stages route via `resolvedFramework`.
 *
 * Returns null only when the org has no `isDefault: true` provider for any
 * framework. Telegram / Slack / chat-title callers keep using the strict
 * framework-scoped variant — they want the claude-code default specifically.
 */
export function getOrgAnyDefaultModelProvider(
  orgId: string,
): Promise<ModelProviderInfo | null> {
  return getAnyDefaultModelProvider(orgId, ORG_SENTINEL_USER_ID);
}

/**
 * Type-only variant of `getOrgAnyDefaultModelProvider`, mirroring the shape
 * of `getOrgDefaultModelProviderType`. Accepts a db handle so callers inside
 * queue-drain transactions can keep the read in the same boundary.
 */
export async function getOrgAnyDefaultModelProviderType(
  orgId: string,
  db: Database = globalThis.services.db,
): Promise<string | null> {
  const [row] = await db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    )
    .limit(1);

  return row?.type ?? null;
}

/**
 * Get a specific model provider by ID, scoped to an org.
 * Returns null if the provider doesn't belong to the org.
 */
/**
 * Get the org-level model provider row for a specific type.
 *
 * Used by `resolveModelProviderSecrets` when the request explicitly overrides
 * `modelProvider` with a type that differs from the workspace default — we
 * need the explicit provider's `selectedModel` / `authMethod` rather than
 * borrowing them from the unrelated default.
 *
 * Returns null when the org has no row of that type, in which case downstream
 * resolution falls back to `getDefaultModel(providerType)` for the model and
 * skips multi-auth resolution (consistent with no-secret-set behavior).
 */
export async function getOrgModelProviderByType(
  orgId: string,
  type: ModelProviderType,
): Promise<ModelProviderInfo | null> {
  const [row] = await globalThis.services.db
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
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  if (!row) return null;
  if (!(row.type in MODEL_PROVIDER_TYPES)) return null;

  return toModelProviderInfo({
    id: row.id,
    type: row.type as ModelProviderType,
    secretName: row.secretName,
    authMethod: row.authMethod,
    isDefault: row.isDefault,
    selectedModel: row.selectedModel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export async function getModelProviderByIdForOrg(
  orgId: string,
  providerId: string,
): Promise<ModelProviderInfo | null> {
  const [row] = await globalThis.services.db
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
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.id, providerId)),
    )
    .limit(1);

  if (!row) return null;

  if (!(row.type in MODEL_PROVIDER_TYPES)) return null;

  return toModelProviderInfo({
    id: row.id,
    type: row.type as ModelProviderType,
    secretName: row.secretName,
    authMethod: row.authMethod,
    isDefault: row.isDefault,
    selectedModel: row.selectedModel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
