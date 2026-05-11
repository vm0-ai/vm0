import { and, eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  SUPPORTED_RUN_MODELS,
  getDefaultOrgModelPolicySeed,
  isModelSupportedByProvider,
  isSupportedRunModel,
  MODEL_PROVIDER_TYPES,
  type ModelProviderCredentialScope,
  type ModelProviderType,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";

type OrgModelPolicyRow = typeof orgModelPolicies.$inferSelect;
type NewOrgModelPolicyRow = typeof orgModelPolicies.$inferInsert;

function isMemberScopedOAuthProvider(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function getPolicyRouteForProvider(params: {
  providerType: ModelProviderType;
  modelProviderId: string | null;
}): {
  credentialScope: ModelProviderCredentialScope;
  modelProviderId: string | null;
} {
  if (isMemberScopedOAuthProvider(params.providerType)) {
    return { credentialScope: "member", modelProviderId: null };
  }
  return {
    credentialScope: "org",
    modelProviderId:
      params.providerType === "vm0" ? null : params.modelProviderId,
  };
}

async function loadRows(orgId: string): Promise<OrgModelPolicyRow[]> {
  return globalThis.services.db
    .select()
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        inArray(orgModelPolicies.model, [...SUPPORTED_RUN_MODELS]),
      ),
    );
}

function getSupportedModelRank(model: string): number {
  const index = SUPPORTED_RUN_MODELS.indexOf(model as SupportedRunModel);
  return index === -1 ? SUPPORTED_RUN_MODELS.length : index;
}

function sortRowsByCatalog(rows: OrgModelPolicyRow[]): OrgModelPolicyRow[] {
  return [...rows].sort((a, b) => {
    return getSupportedModelRank(a.model) - getSupportedModelRank(b.model);
  });
}

async function loadOrgDefaultProviderSeed(orgId: string): Promise<{
  providerType: ModelProviderType;
  selectedModel: SupportedRunModel | null;
  credentialScope: ModelProviderCredentialScope;
  modelProviderId: string | null;
} | null> {
  const [provider] = await globalThis.services.db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    )
    .limit(1);

  if (!provider || !(provider.type in MODEL_PROVIDER_TYPES)) return null;
  const providerType = provider.type as ModelProviderType;
  const route = getPolicyRouteForProvider({
    providerType,
    modelProviderId: provider.id,
  });
  return {
    providerType,
    selectedModel: isSupportedRunModel(provider.selectedModel)
      ? provider.selectedModel
      : null,
    credentialScope: route.credentialScope,
    modelProviderId: route.modelProviderId,
  };
}

async function getDefaultPolicySeeds(
  orgId: string,
): Promise<
  Array<
    Omit<
      NewOrgModelPolicyRow,
      | "id"
      | "orgId"
      | "createdAt"
      | "updatedAt"
      | "createdByUserId"
      | "updatedByUserId"
    >
  >
> {
  const seed = getDefaultOrgModelPolicySeed();
  const provider = await loadOrgDefaultProviderSeed(orgId);
  if (!provider) return seed;

  const firstSupportedModel = seed.find((policy) => {
    return isModelSupportedByProvider(policy.model, provider.providerType);
  })?.model;
  if (!firstSupportedModel) return seed;

  const preferredDefault =
    provider.selectedModel &&
    isModelSupportedByProvider(provider.selectedModel, provider.providerType)
      ? provider.selectedModel
      : firstSupportedModel;

  return seed.map((policy) => {
    if (!isModelSupportedByProvider(policy.model, provider.providerType)) {
      return { ...policy, isDefault: false };
    }
    return {
      model: policy.model,
      isDefault: policy.model === preferredDefault,
      defaultProviderType: provider.providerType,
      credentialScope: provider.credentialScope,
      modelProviderId: provider.modelProviderId,
    };
  });
}

export async function syncOrgDefaultModelPoliciesForProvider(params: {
  orgId: string;
  providerType: ModelProviderType;
  modelProviderId: string | null;
  selectedModel: string | null;
}): Promise<void> {
  const selectedModel = isSupportedRunModel(params.selectedModel)
    ? params.selectedModel
    : null;
  const seeds = await getDefaultPolicySeeds(params.orgId);
  const hasSelectedModelSeed = seeds.some((seed) => {
    return seed.model === selectedModel;
  });
  if (
    selectedModel &&
    !hasSelectedModelSeed &&
    isModelSupportedByProvider(selectedModel, params.providerType)
  ) {
    const route = getPolicyRouteForProvider({
      providerType: params.providerType,
      modelProviderId: params.modelProviderId,
    });
    seeds.push({
      model: selectedModel,
      isDefault: true,
      defaultProviderType: params.providerType,
      credentialScope: route.credentialScope,
      modelProviderId: route.modelProviderId,
    });
  }

  if (selectedModel) {
    for (const seed of seeds) {
      seed.isDefault = seed.model === selectedModel;
    }
  }

  await globalThis.services.db
    .update(orgModelPolicies)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(eq(orgModelPolicies.orgId, params.orgId));

  await globalThis.services.db
    .insert(orgModelPolicies)
    .values(
      seeds.map((seed) => {
        return {
          ...seed,
          orgId: params.orgId,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
      set: {
        isDefault: sql.raw("excluded.is_default"),
        defaultProviderType: sql.raw("excluded.default_provider_type"),
        credentialScope: sql.raw("excluded.credential_scope"),
        modelProviderId: sql.raw("excluded.model_provider_id"),
        updatedAt: new Date(),
      },
    });
}

export async function ensureOrgModelPolicies(
  orgId: string,
  userId?: string,
): Promise<OrgModelPolicyRow[]> {
  const existing = await loadRows(orgId);
  if (existing.length > 0) {
    if (
      existing.some((policy) => {
        return policy.isDefault;
      })
    ) {
      return sortRowsByCatalog(existing);
    }

    const fallbackDefault =
      existing.find((policy) => {
        return policy.model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
      }) ?? sortRowsByCatalog(existing)[0];
    if (fallbackDefault) {
      await globalThis.services.db
        .update(orgModelPolicies)
        .set({
          isDefault: true,
          updatedByUserId: userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(orgModelPolicies.id, fallbackDefault.id));
      return sortRowsByCatalog(await loadRows(orgId));
    }
    return sortRowsByCatalog(existing);
  }

  const existingModels = new Set(
    existing.map((policy) => {
      return policy.model;
    }),
  );
  const defaultPolicySeeds = await getDefaultPolicySeeds(orgId);
  const missing = defaultPolicySeeds
    .filter((seed) => {
      return !existingModels.has(seed.model);
    })
    .map((seed) => {
      return {
        ...seed,
        orgId,
        createdByUserId: userId ?? null,
        updatedByUserId: userId ?? null,
      };
    });

  if (missing.length === 0) {
    return sortRowsByCatalog(existing);
  }

  await globalThis.services.db
    .insert(orgModelPolicies)
    .values(missing)
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });

  return sortRowsByCatalog(await loadRows(orgId));
}
