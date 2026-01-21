import { eq, and, inArray } from "drizzle-orm";
import {
  MODEL_PROVIDER_TYPES,
  getFrameworkForType,
  getCredentialNameForType,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { modelProviders } from "../../db/schema/model-provider";
import { credentials } from "../../db/schema/credential";
import { encryptCredentialValue } from "../crypto";
import { BadRequestError, NotFoundError, ConflictError } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";

const log = logger("service:model-provider");

interface ModelProviderInfo {
  id: string;
  type: ModelProviderType;
  framework: ModelProviderFramework;
  credentialName: string;
  isDefault: boolean;
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

  const result = await globalThis.services.db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      isDefault: modelProviders.isDefault,
      credentialName: credentials.name,
      createdAt: modelProviders.createdAt,
      updatedAt: modelProviders.updatedAt,
    })
    .from(modelProviders)
    .innerJoin(credentials, eq(modelProviders.credentialId, credentials.id))
    .where(eq(modelProviders.scopeId, scope.id))
    .orderBy(modelProviders.type);

  return result.map((row) => ({
    ...row,
    type: row.type as ModelProviderType,
    framework: getFrameworkForType(row.type as ModelProviderType),
  }));
}

/**
 * Check if credential exists for a model provider type
 */
export async function checkCredentialExists(
  clerkUserId: string,
  type: ModelProviderType,
): Promise<{ exists: boolean; currentType?: "user" | "model-provider" }> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return { exists: false };
  }

  const credentialName = getCredentialNameForType(type);
  const [existing] = await globalThis.services.db
    .select({ type: credentials.type })
    .from(credentials)
    .where(
      and(
        eq(credentials.scopeId, scope.id),
        eq(credentials.name, credentialName),
      ),
    )
    .limit(1);

  if (!existing) {
    return { exists: false };
  }

  return {
    exists: true,
    currentType: existing.type as "user" | "model-provider",
  };
}

/**
 * Create or update a model provider
 * @param convertExisting If true, convert existing 'user' credential to 'model-provider'
 */
export async function upsertModelProvider(
  clerkUserId: string,
  type: ModelProviderType,
  credential: string,
  convertExisting: boolean = false,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw new BadRequestError(
      "You need to configure a scope first. Run `vm0 scope create` to set up your scope.",
    );
  }

  const credentialName = getCredentialNameForType(type);
  const framework = getFrameworkForType(type);
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(credential, encryptionKey);

  log.debug("upserting model provider", {
    scopeId: scope.id,
    type,
    credentialName,
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
    // Update existing credential value
    await globalThis.services.db
      .update(credentials)
      .set({ encryptedValue, updatedAt: new Date() })
      .where(eq(credentials.id, existingProvider.credentialId));

    await globalThis.services.db
      .update(modelProviders)
      .set({ updatedAt: new Date() })
      .where(eq(modelProviders.id, existingProvider.id));

    log.debug("model provider updated", {
      providerId: existingProvider.id,
      type,
    });

    return {
      provider: {
        id: existingProvider.id,
        type,
        framework,
        credentialName,
        isDefault: existingProvider.isDefault,
        createdAt: existingProvider.createdAt,
        updatedAt: new Date(),
      },
      created: false,
    };
  }

  // Check if credential exists with same name
  const [existingCredential] = await globalThis.services.db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.scopeId, scope.id),
        eq(credentials.name, credentialName),
      ),
    )
    .limit(1);

  if (existingCredential) {
    if (existingCredential.type === "user" && !convertExisting) {
      // Conflict: user credential exists, need explicit conversion
      throw new ConflictError(
        `Credential "${credentialName}" already exists. Use --convert to convert it to a model provider.`,
      );
    }

    // Convert existing credential or update model-provider credential
    await globalThis.services.db
      .update(credentials)
      .set({
        encryptedValue,
        type: "model-provider",
        updatedAt: new Date(),
      })
      .where(eq(credentials.id, existingCredential.id));

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
        credentialId: existingCredential.id,
        isDefault: !hasProviderForFramework,
      })
      .returning();

    if (!created) {
      throw new Error("Failed to create model provider");
    }

    log.debug("model provider created from existing credential", {
      providerId: created.id,
      type,
      converted: existingCredential.type === "user",
    });

    return {
      provider: {
        id: created.id,
        type,
        framework,
        credentialName,
        isDefault: created.isDefault,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
      created: true,
    };
  }

  // Create new credential and model provider
  // Check if first for framework
  const allProviders = await listModelProviders(clerkUserId);
  const hasProviderForFramework = allProviders.some(
    (p) => p.framework === framework,
  );

  const [newCredential] = await globalThis.services.db
    .insert(credentials)
    .values({
      scopeId: scope.id,
      name: credentialName,
      encryptedValue,
      type: "model-provider",
      description: `Model provider credential for ${MODEL_PROVIDER_TYPES[type].label}`,
    })
    .returning();

  if (!newCredential) {
    throw new Error("Failed to create credential");
  }

  const [newProvider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      scopeId: scope.id,
      type,
      credentialId: newCredential.id,
      isDefault: !hasProviderForFramework,
    })
    .returning();

  if (!newProvider) {
    throw new Error("Failed to create model provider");
  }

  log.debug("model provider created", {
    providerId: newProvider.id,
    credentialId: newCredential.id,
    type,
    isDefault: newProvider.isDefault,
  });

  return {
    provider: {
      id: newProvider.id,
      type,
      framework,
      credentialName,
      isDefault: newProvider.isDefault,
      createdAt: newProvider.createdAt,
      updatedAt: newProvider.updatedAt,
    },
    created: true,
  };
}

/**
 * Convert existing user credential to model provider
 */
export async function convertCredentialToModelProvider(
  clerkUserId: string,
  type: ModelProviderType,
): Promise<ModelProviderInfo> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw new NotFoundError("Credential not found");
  }

  const credentialName = getCredentialNameForType(type);
  const framework = getFrameworkForType(type);

  // Find the credential
  const [existingCredential] = await globalThis.services.db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.scopeId, scope.id),
        eq(credentials.name, credentialName),
      ),
    )
    .limit(1);

  if (!existingCredential) {
    throw new NotFoundError(`Credential "${credentialName}" not found`);
  }

  if (existingCredential.type === "model-provider") {
    throw new BadRequestError(
      `Credential "${credentialName}" is already a model provider`,
    );
  }

  // Update credential type
  await globalThis.services.db
    .update(credentials)
    .set({ type: "model-provider", updatedAt: new Date() })
    .where(eq(credentials.id, existingCredential.id));

  // Check if first for framework
  const allProviders = await listModelProviders(clerkUserId);
  const hasProviderForFramework = allProviders.some(
    (p) => p.framework === framework,
  );

  // Create model provider row
  const [newProvider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      scopeId: scope.id,
      type,
      credentialId: existingCredential.id,
      isDefault: !hasProviderForFramework,
    })
    .returning();

  if (!newProvider) {
    throw new Error("Failed to create model provider");
  }

  log.debug("credential converted to model provider", {
    providerId: newProvider.id,
    credentialId: existingCredential.id,
    type,
  });

  return {
    id: newProvider.id,
    type,
    framework,
    credentialName,
    isDefault: newProvider.isDefault,
    createdAt: newProvider.createdAt,
    updatedAt: newProvider.updatedAt,
  };
}

/**
 * Delete a model provider and its credential
 */
export async function deleteModelProvider(
  clerkUserId: string,
  type: ModelProviderType,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw new NotFoundError("Model provider not found");
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
    throw new NotFoundError(`Model provider "${type}" not found`);
  }

  const wasDefault = provider.isDefault;
  const credentialId = provider.credentialId;

  // Delete credential (cascades to model_provider)
  await globalThis.services.db
    .delete(credentials)
    .where(eq(credentials.id, credentialId));

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
    throw new NotFoundError("Model provider not found");
  }

  const framework = getFrameworkForType(type);
  const credentialName = getCredentialNameForType(type);

  // Find the target provider
  const [target] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(eq(modelProviders.scopeId, scope.id), eq(modelProviders.type, type)),
    )
    .limit(1);

  if (!target) {
    throw new NotFoundError(`Model provider "${type}" not found`);
  }

  if (target.isDefault) {
    return {
      id: target.id,
      type,
      framework,
      credentialName,
      isDefault: true,
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
    credentialName,
    isDefault: true,
    createdAt: target.createdAt,
    updatedAt: new Date(),
  };
}

/**
 * Get the default model provider for a framework
 */
export async function getDefaultModelProvider(
  scopeId: string,
  framework: ModelProviderFramework,
): Promise<ModelProviderInfo | null> {
  const allProviders = await globalThis.services.db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      isDefault: modelProviders.isDefault,
      credentialName: credentials.name,
      createdAt: modelProviders.createdAt,
      updatedAt: modelProviders.updatedAt,
    })
    .from(modelProviders)
    .innerJoin(credentials, eq(modelProviders.credentialId, credentials.id))
    .where(eq(modelProviders.scopeId, scopeId));

  const defaultProvider = allProviders.find(
    (p) =>
      p.isDefault &&
      getFrameworkForType(p.type as ModelProviderType) === framework,
  );

  if (!defaultProvider) {
    return null;
  }

  return {
    ...defaultProvider,
    type: defaultProvider.type as ModelProviderType,
    framework,
  };
}
