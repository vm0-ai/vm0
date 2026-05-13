import { and, eq } from "drizzle-orm";
import {
  MODEL_PROVIDER_TYPES,
  getSecretNameForType,
  isModelSupportedByProvider,
  isSupportedRunModel,
  modelProviderCredentialScopeSchema,
  normalizeRunModelId,
  type ModelProviderCredentialScope,
  type ModelProviderType,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  badRequest,
  noModelProvider,
  providerDeleted,
} from "@vm0/api-services/errors";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { ensureOrgModelPolicies } from "./org-model-policy-service";
import { getUserModelPreferenceModel } from "./user-model-preference-service";
import {
  getModelProviderById,
  type ModelProviderInfo,
} from "../model-provider/model-provider-service";

type OrgModelPolicyRow = typeof orgModelPolicies.$inferSelect;

export interface ModelFirstRouteDescriptor {
  selectedModel: SupportedRunModel;
  providerType: ModelProviderType;
  credentialScope: ModelProviderCredentialScope;
  modelProviderId: string | null;
}

interface ResolveRouteParams {
  orgId: string;
  userId: string;
  selectedModel?: string | null;
  providerType?: string | null;
  credentialScope?: string | null;
  modelProviderId?: string | null;
}

function parseProviderType(type: string): ModelProviderType {
  if (type in MODEL_PROVIDER_TYPES) {
    return type as ModelProviderType;
  }
  throw badRequest(`Unknown model provider type "${type}"`);
}

function parseCredentialScope(scope: string): ModelProviderCredentialScope {
  const parsed = modelProviderCredentialScopeSchema.safeParse(scope);
  if (parsed.success) return parsed.data;
  throw badRequest(`Unknown model provider credential scope "${scope}"`);
}

function canonicalizeRunModel(model: string): SupportedRunModel {
  const canonical = normalizeRunModelId(model);
  if (isSupportedRunModel(canonical)) return canonical;
  throw badRequest(`Unknown model "${model}"`);
}

function routeShapeFromPolicy(
  policy: OrgModelPolicyRow,
): ModelFirstRouteDescriptor {
  const selectedModel = canonicalizeRunModel(policy.model);
  const providerType = parseProviderType(policy.defaultProviderType);
  const credentialScope = parseCredentialScope(policy.credentialScope);

  return normalizeModelFirstRouteDescriptor({
    selectedModel,
    providerType,
    credentialScope,
    modelProviderId: policy.modelProviderId ?? null,
  });
}

function normalizeModelFirstRouteDescriptor(
  route: ModelFirstRouteDescriptor,
): ModelFirstRouteDescriptor {
  if (route.providerType === "vm0" && route.modelProviderId) {
    return { ...route, modelProviderId: null };
  }

  return route;
}

function validateRouteShape(route: ModelFirstRouteDescriptor): void {
  if (!isModelSupportedByProvider(route.selectedModel, route.providerType)) {
    throw badRequest(
      `Model "${route.selectedModel}" is not supported by provider "${route.providerType}"`,
    );
  }

  if (route.credentialScope === "member") {
    if (route.modelProviderId) {
      throw badRequest("Member-scoped model routes cannot store provider IDs");
    }
    if (
      route.providerType !== "claude-code-oauth-token" &&
      route.providerType !== "codex-oauth-token"
    ) {
      throw badRequest(
        `Member-scoped model routes require an OAuth provider, got "${route.providerType}"`,
      );
    }
    return;
  }

  if (route.providerType === "vm0") {
    if (route.modelProviderId) {
      throw badRequest("Built-in model routes cannot store provider IDs");
    }
    return;
  }
}

async function getOrgProviderById(
  orgId: string,
  modelProviderId: string,
): Promise<ModelProviderInfo | null> {
  const [row] = await globalThis.services.db
    .select({
      id: modelProviders.id,
      userId: modelProviders.userId,
      type: modelProviders.type,
      isDefault: modelProviders.isDefault,
      selectedModel: modelProviders.selectedModel,
      authMethod: modelProviders.authMethod,
      tokenExpiresAt: modelProviders.tokenExpiresAt,
      needsReconnect: modelProviders.needsReconnect,
      lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
      workspaceName: modelProviders.workspaceName,
      planType: modelProviders.planType,
      createdAt: modelProviders.createdAt,
      updatedAt: modelProviders.updatedAt,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, modelProviderId),
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
      ),
    )
    .limit(1);

  if (!row) return null;
  const type = parseProviderType(row.type);
  return {
    ...row,
    type,
    framework: MODEL_PROVIDER_TYPES[type].framework,
    secretName: getSecretNameForType(type) ?? null,
    secretNames: null,
  };
}

async function validateOrgProviderRoute(
  orgId: string,
  route: ModelFirstRouteDescriptor,
): Promise<boolean> {
  validateRouteShape(route);
  if (route.credentialScope !== "org" || route.providerType === "vm0") {
    return true;
  }
  if (!route.modelProviderId) {
    return false;
  }

  const provider = await getOrgProviderById(orgId, route.modelProviderId);
  if (!provider || provider.type !== route.providerType) {
    return false;
  }
  return true;
}

async function loadPolicyByModel(
  orgId: string,
  selectedModel: SupportedRunModel,
): Promise<OrgModelPolicyRow | undefined> {
  await ensureOrgModelPolicies(orgId);
  const [policy] = await globalThis.services.db
    .select()
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.model, selectedModel),
      ),
    )
    .limit(1);
  return policy;
}

async function resolveRouteFromPolicy(
  orgId: string,
  policy: OrgModelPolicyRow,
): Promise<ModelFirstRouteDescriptor> {
  const route = routeShapeFromPolicy(policy);
  if (!(await validateOrgProviderRoute(orgId, route))) {
    throw providerDeleted();
  }
  return route;
}

async function resolveDefaultRoute(
  orgId: string,
): Promise<ModelFirstRouteDescriptor> {
  await ensureOrgModelPolicies(orgId);
  const [policy] = await globalThis.services.db
    .select()
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.isDefault, true),
      ),
    )
    .limit(1);

  if (!policy) {
    throw noModelProvider();
  }
  return resolveRouteFromPolicy(orgId, policy);
}

async function resolveUserPreferenceOrDefaultRoute(
  orgId: string,
  userId: string,
): Promise<ModelFirstRouteDescriptor> {
  const userModel = await getUserModelPreferenceModel(orgId, userId);
  if (userModel) {
    const policy = await loadPolicyByModel(orgId, userModel);
    if (policy) {
      return resolveRouteFromPolicy(orgId, policy);
    }
  }
  return resolveDefaultRoute(orgId);
}

async function deriveRouteFromPinnedProvider(
  orgId: string,
  userId: string,
  selectedModel: SupportedRunModel,
  modelProviderId: string,
): Promise<ModelFirstRouteDescriptor> {
  const provider = await getModelProviderById(orgId, userId, modelProviderId);
  if (!provider) {
    throw badRequest("Pinned model provider route is no longer valid");
  }
  const credentialScope =
    provider.userId === ORG_SENTINEL_USER_ID ? "org" : "member";
  return {
    selectedModel,
    providerType: provider.type,
    credentialScope,
    modelProviderId: credentialScope === "org" ? modelProviderId : null,
  };
}

async function validateModelConfigured(
  orgId: string,
  selectedModel: SupportedRunModel,
): Promise<void> {
  const policy = await loadPolicyByModel(orgId, selectedModel);
  if (!policy) {
    throw badRequest(
      `Model "${selectedModel}" is not configured for this workspace`,
    );
  }
}

export async function resolveModelFirstRouteDescriptor(
  params: ResolveRouteParams,
): Promise<ModelFirstRouteDescriptor> {
  if (!params.selectedModel) {
    return resolveUserPreferenceOrDefaultRoute(params.orgId, params.userId);
  }

  const selectedModel = canonicalizeRunModel(params.selectedModel);
  await validateModelConfigured(params.orgId, selectedModel);

  const providerType = params.providerType
    ? parseProviderType(params.providerType)
    : undefined;
  const credentialScope = params.credentialScope
    ? parseCredentialScope(params.credentialScope)
    : undefined;

  let route: ModelFirstRouteDescriptor | undefined;
  if (providerType) {
    route = {
      selectedModel,
      providerType,
      credentialScope:
        credentialScope ??
        (providerType === "claude-code-oauth-token" ||
        providerType === "codex-oauth-token"
          ? "member"
          : "org"),
      modelProviderId: params.modelProviderId ?? null,
    };
    if (
      route.credentialScope === "org" &&
      route.providerType !== "vm0" &&
      !route.modelProviderId
    ) {
      throw badRequest(
        `Org-scoped provider "${route.providerType}" requires a model provider ID`,
      );
    }
  } else if (params.modelProviderId) {
    route = await deriveRouteFromPinnedProvider(
      params.orgId,
      params.userId,
      selectedModel,
      params.modelProviderId,
    );
  } else {
    const policy = await loadPolicyByModel(params.orgId, selectedModel);
    if (!policy) {
      throw badRequest(
        `Model "${selectedModel}" is not configured for this workspace`,
      );
    }
    return resolveRouteFromPolicy(params.orgId, policy);
  }

  route = normalizeModelFirstRouteDescriptor(route);
  if (!(await validateOrgProviderRoute(params.orgId, route))) {
    throw providerDeleted();
  }
  return route;
}
