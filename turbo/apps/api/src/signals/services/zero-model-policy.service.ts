import { command } from "ccstate";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  DEFAULT_ORG_MODEL_POLICY_MODELS,
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  LIMITED_FREE1_DEFAULT_RUN_MODEL,
  MODEL_PROVIDER_TYPES,
  SUPPORTED_RUN_MODELS,
  getCanonicalModelDisplayName,
  getDefaultOrgModelPolicySeed,
  isModelSupportedByProvider,
  isLimitedFree1RestrictedRunModel,
  type ModelProviderCredentialScope,
  type ModelProviderType,
  type OrgModelPoliciesResponse,
  type OrgModelPolicy,
  type OrgModelPolicyRouteStatus,
  type SupportedRunModel,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";

import { insufficientCredits } from "../../lib/error";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";

type OrgModelPolicyRow = typeof orgModelPolicies.$inferSelect;

interface ProviderRouteInfo {
  readonly id: string;
  readonly userId: string;
  readonly type: ModelProviderType;
}

type ServiceResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: false;
      readonly response: ReturnType<typeof insufficientCredits>;
    };

const ORG_SENTINEL_USER_ID = "__org__";

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

function bad<T>(message: string): ServiceResult<T> {
  return { ok: false, message };
}

function planRestricted<T>(): ServiceResult<T> {
  return { ok: false, response: insufficientCredits() };
}

function isOAuthMemberProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function parseProviderType(value: string): ModelProviderType | null {
  return value in MODEL_PROVIDER_TYPES ? (value as ModelProviderType) : null;
}

function parseSupportedModel(value: string): SupportedRunModel | null {
  return SUPPORTED_RUN_MODELS.includes(value as SupportedRunModel)
    ? (value as SupportedRunModel)
    : null;
}

function parseCredentialScope(
  value: string,
): ModelProviderCredentialScope | null {
  return value === "org" || value === "member" ? value : null;
}

function loadRows(db: Db, orgId: string): Promise<OrgModelPolicyRow[]> {
  return db
    .select()
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        inArray(orgModelPolicies.model, [...SUPPORTED_RUN_MODELS]),
      ),
    );
}

async function orgModelCapabilities(
  db: Db,
  orgId: string,
): Promise<Pick<OrgPlanCapabilities, "restrictedVm0Models" | "supportByok">> {
  const capabilities = await loadOrgPlanCapabilities(db, orgId);
  if (capabilities?.status !== "active") {
    return {
      restrictedVm0Models: false,
      supportByok: true,
    };
  }
  return {
    restrictedVm0Models: capabilities.restrictedVm0Models,
    supportByok: capabilities.supportByok,
  };
}

function modelAllowedForOrgPlan(
  model: string,
  capabilities: Pick<OrgPlanCapabilities, "restrictedVm0Models">,
): boolean {
  return (
    !capabilities.restrictedVm0Models ||
    !isLimitedFree1RestrictedRunModel(model)
  );
}

function modelProviderAllowedForOrgPlan(
  providerType: ModelProviderType,
  capabilities: Pick<OrgPlanCapabilities, "supportByok">,
): boolean {
  return capabilities.supportByok || providerType === "vm0";
}

function getSupportedModelRank(model: string): number {
  const curatedIndex = DEFAULT_ORG_MODEL_POLICY_MODELS.indexOf(
    model as (typeof DEFAULT_ORG_MODEL_POLICY_MODELS)[number],
  );
  if (curatedIndex !== -1) {
    return curatedIndex;
  }
  const catalogIndex = SUPPORTED_RUN_MODELS.indexOf(model as SupportedRunModel);
  return catalogIndex === -1
    ? DEFAULT_ORG_MODEL_POLICY_MODELS.length + SUPPORTED_RUN_MODELS.length
    : DEFAULT_ORG_MODEL_POLICY_MODELS.length + catalogIndex;
}

function sortRowsByCatalog(rows: OrgModelPolicyRow[]): OrgModelPolicyRow[] {
  return [...rows].sort((a, b) => {
    return getSupportedModelRank(a.model) - getSupportedModelRank(b.model);
  });
}

function isLimitedFreeReplaceableStandardDefaultModel(model: string): boolean {
  // MiniMax-M3 was the previous VM0-managed default; limited-free orgs seeded
  // before this change still need to converge to the current built-in route.
  return (
    model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL || model === "MiniMax-M3"
  );
}

function getSeedDefaultModelForPlan(
  capabilities: Pick<OrgPlanCapabilities, "restrictedVm0Models">,
): SupportedRunModel {
  return capabilities.restrictedVm0Models
    ? LIMITED_FREE1_DEFAULT_RUN_MODEL
    : DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
}

function shouldReplaceExistingDefaultForPlan(
  existingDefault: OrgModelPolicyRow | undefined,
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedVm0Models" | "supportByok"
  >,
): boolean {
  if (capabilities.supportByok && !capabilities.restrictedVm0Models) {
    return existingDefault === undefined;
  }
  if (existingDefault === undefined) {
    return true;
  }
  const shouldReplaceModel =
    capabilities.restrictedVm0Models &&
    existingDefault.model !== LIMITED_FREE1_DEFAULT_RUN_MODEL &&
    (isLimitedFreeReplaceableStandardDefaultModel(existingDefault.model) ||
      isLimitedFree1RestrictedRunModel(existingDefault.model));
  return (
    shouldReplaceModel ||
    (!capabilities.supportByok &&
      (existingDefault.defaultProviderType !== "vm0" ||
        existingDefault.credentialScope !== "org" ||
        existingDefault.modelProviderId !== null))
  );
}

async function ensureModelPolicy(
  db: Db,
  orgId: string,
  userId: string,
  model: SupportedRunModel,
): Promise<void> {
  const now = nowDate();
  await db
    .insert(orgModelPolicies)
    .values({
      model,
      isDefault: false,
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
      orgId,
      createdByUserId: userId,
      updatedByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });
}

async function setDefaultModelPolicy(
  db: Db,
  orgId: string,
  userId: string,
  model: SupportedRunModel,
  options?: { readonly resetRouteToBuiltIn?: boolean },
): Promise<void> {
  await ensureModelPolicy(db, orgId, userId, model);
  const now = nowDate();
  await db
    .update(orgModelPolicies)
    .set({
      isDefault: false,
      updatedByUserId: userId,
      updatedAt: now,
    })
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.isDefault, true),
      ),
    );
  await db
    .update(orgModelPolicies)
    .set({
      isDefault: true,
      ...(options?.resetRouteToBuiltIn === true
        ? {
            defaultProviderType: "vm0",
            credentialScope: "org",
            modelProviderId: null,
          }
        : {}),
      updatedByUserId: userId,
      updatedAt: now,
    })
    .where(
      and(eq(orgModelPolicies.orgId, orgId), eq(orgModelPolicies.model, model)),
    );
}

export async function ensureOrgModelPolicies(
  db: Db,
  orgId: string,
  userId: string,
): Promise<OrgModelPolicyRow[]> {
  const capabilities = await orgModelCapabilities(db, orgId);
  const seedDefaultModel = getSeedDefaultModelForPlan(capabilities);
  const existing = await loadRows(db, orgId);
  if (existing.length > 0) {
    const existingDefault = existing.find((policy) => {
      return policy.isDefault;
    });
    if (!shouldReplaceExistingDefaultForPlan(existingDefault, capabilities)) {
      return sortRowsByCatalog(existing);
    }

    if (!capabilities.supportByok || capabilities.restrictedVm0Models) {
      await setDefaultModelPolicy(db, orgId, userId, seedDefaultModel, {
        resetRouteToBuiltIn: !capabilities.supportByok,
      });
      return sortRowsByCatalog(await loadRows(db, orgId));
    }

    const fallbackDefault =
      existing.find((policy) => {
        return policy.model === seedDefaultModel;
      }) ?? sortRowsByCatalog(existing)[0];
    if (fallbackDefault) {
      await setDefaultModelPolicy(
        db,
        orgId,
        userId,
        parseSupportedModel(fallbackDefault.model) ?? seedDefaultModel,
      );
      return sortRowsByCatalog(await loadRows(db, orgId));
    }
    return sortRowsByCatalog(existing);
  }

  const existingModels = new Set(
    existing.map((policy) => {
      return policy.model;
    }),
  );
  const missing = getDefaultOrgModelPolicySeed(seedDefaultModel)
    .filter((seed) => {
      return !existingModels.has(seed.model);
    })
    .map((seed) => {
      return {
        ...seed,
        orgId,
        createdByUserId: userId,
        updatedByUserId: userId,
      };
    });

  if (missing.length === 0) {
    return existing;
  }

  await db
    .insert(orgModelPolicies)
    .values(missing)
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });

  return sortRowsByCatalog(await loadRows(db, orgId));
}

async function listOrgProviderRoutes(
  db: Db,
  orgId: string,
): Promise<ProviderRouteInfo[]> {
  const rows = await db
    .select({
      id: modelProviders.id,
      userId: modelProviders.userId,
      type: modelProviders.type,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
      ),
    );

  return rows.flatMap((row) => {
    const type = parseProviderType(row.type);
    return type ? [{ id: row.id, userId: row.userId, type }] : [];
  });
}

async function validateOrgProviderRoute(
  db: Db,
  orgId: string,
  policy: UpdateOrgModelPolicy,
): Promise<string | null> {
  if (!isModelSupportedByProvider(policy.model, policy.defaultProviderType)) {
    return `Model "${policy.model}" is not supported by provider "${policy.defaultProviderType}"`;
  }

  if (policy.credentialScope === "member") {
    if (!isOAuthMemberProviderType(policy.defaultProviderType)) {
      return "Member routes require an OAuth provider";
    }
    if (policy.modelProviderId) {
      return "Member routes cannot store a provider ID";
    }
    return null;
  }

  if (isOAuthMemberProviderType(policy.defaultProviderType)) {
    return "OAuth provider routes must use member credentials";
  }

  if (policy.defaultProviderType === "vm0") {
    if (policy.modelProviderId) {
      return "Built-in routes cannot store a provider ID";
    }
    return null;
  }

  if (!policy.modelProviderId) {
    return "Org provider routes require a provider ID";
  }

  const [provider] = await db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      userId: modelProviders.userId,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.id, policy.modelProviderId),
      ),
    )
    .limit(1);

  if (!provider || provider.userId !== ORG_SENTINEL_USER_ID) {
    return "Selected provider is not configured for this workspace";
  }
  if (provider.type !== policy.defaultProviderType) {
    return "Selected provider type does not match the route";
  }

  return null;
}

async function validateUpdatePolicies(
  db: Db,
  orgId: string,
  policies: UpdateOrgModelPolicy[],
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedVm0Models" | "supportByok"
  >,
): Promise<ServiceResult<UpdateOrgModelPolicy[]>> {
  if (policies.length === 0) {
    return bad("Request must include at least one model");
  }

  const seenModels = new Set<string>();
  let defaultCount = 0;

  for (const policy of policies) {
    if (!parseSupportedModel(policy.model)) {
      return bad(`Unknown model "${policy.model}"`);
    }
    if (!modelAllowedForOrgPlan(policy.model, capabilities)) {
      return planRestricted();
    }
    const providerType = parseProviderType(policy.defaultProviderType);
    if (!providerType) {
      return bad(`Unknown model provider type "${policy.defaultProviderType}"`);
    }
    if (!modelProviderAllowedForOrgPlan(providerType, capabilities)) {
      return planRestricted();
    }
    if (!parseCredentialScope(policy.credentialScope)) {
      return bad(`Unknown credential scope "${policy.credentialScope}"`);
    }

    if (seenModels.has(policy.model)) {
      return bad(`Duplicate model "${policy.model}"`);
    }
    seenModels.add(policy.model);

    if (policy.isDefault) {
      defaultCount += 1;
    }

    const routeError = await validateOrgProviderRoute(db, orgId, policy);
    if (routeError) {
      return bad(routeError);
    }
  }

  if (defaultCount !== 1) {
    return bad("Request must include exactly one default model");
  }

  return ok([...policies]);
}

function getRouteStatus(params: {
  readonly model: SupportedRunModel;
  readonly providerType: ModelProviderType;
  readonly credentialScope: ModelProviderCredentialScope;
  readonly modelProviderId: string | null;
  readonly providersById: Map<string, ProviderRouteInfo>;
}): {
  readonly status: OrgModelPolicyRouteStatus;
  readonly reason: string | null;
} {
  const {
    model,
    providerType,
    credentialScope,
    modelProviderId,
    providersById,
  } = params;

  if (!isModelSupportedByProvider(model, providerType)) {
    return {
      status: "invalid",
      reason: "Provider does not support this model.",
    };
  }
  if (credentialScope === "member") {
    if (!isOAuthMemberProviderType(providerType)) {
      return {
        status: "invalid",
        reason: "Member route requires an OAuth provider.",
      };
    }
    return { status: "valid", reason: null };
  }
  if (providerType === "vm0") {
    return { status: "valid", reason: null };
  }
  if (!modelProviderId) {
    return {
      status: "missing_provider",
      reason: "The selected workspace provider is missing.",
    };
  }
  const provider = providersById.get(modelProviderId);
  if (!provider || provider.type !== providerType) {
    return {
      status: "missing_provider",
      reason: "The selected workspace provider is missing.",
    };
  }
  return { status: "valid", reason: null };
}

function serializePolicy(
  policy: OrgModelPolicyRow,
  providersById: Map<string, ProviderRouteInfo>,
): OrgModelPolicy {
  const model = parseSupportedModel(policy.model);
  const providerType = parseProviderType(policy.defaultProviderType);
  const credentialScope = parseCredentialScope(policy.credentialScope);
  if (!model || !providerType || !credentialScope) {
    throw new Error("Stored org model policy contains unsupported values");
  }

  const route = getRouteStatus({
    model,
    providerType,
    credentialScope,
    modelProviderId: policy.modelProviderId ?? null,
    providersById,
  });

  return {
    id: policy.id,
    model,
    modelLabel: getCanonicalModelDisplayName(model),
    isDefault: policy.isDefault,
    defaultProviderType: providerType,
    credentialScope,
    modelProviderId: policy.modelProviderId ?? null,
    routeStatus: route.status,
    routeStatusReason: route.reason,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function selectWorkspaceDefaultPolicy(
  policies: OrgModelPolicy[],
): OrgModelPolicy | null {
  return (
    policies.find((policy) => {
      return policy.isDefault;
    }) ?? null
  );
}

async function listOrgModelPolicies(
  db: Db,
  orgId: string,
  userId: string,
): Promise<OrgModelPoliciesResponse> {
  const rows = await ensureOrgModelPolicies(db, orgId, userId);
  const providers = await listOrgProviderRoutes(db, orgId);
  const providersById = new Map(
    providers.map((provider) => {
      return [provider.id, provider];
    }),
  );
  const policies = rows.map((row) => {
    return serializePolicy(row, providersById);
  });
  const workspaceDefault = selectWorkspaceDefaultPolicy(policies);

  return {
    policies,
    workspaceDefaultModel: workspaceDefault?.model ?? null,
    workspaceDefaultPolicyId: workspaceDefault?.id ?? null,
  };
}

export const listOrgModelPolicies$ = command(
  async (
    { set },
    params: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<OrgModelPoliciesResponse> => {
    const db = set(writeDb$);
    const response = await listOrgModelPolicies(
      db,
      params.orgId,
      params.userId,
    );
    signal.throwIfAborted();
    return response;
  },
);

export const updateOrgModelPolicies$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly policies: UpdateOrgModelPolicy[];
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<OrgModelPoliciesResponse>> => {
    const db = set(writeDb$);
    const capabilities = await orgModelCapabilities(db, params.orgId);
    signal.throwIfAborted();
    const validation = await validateUpdatePolicies(
      db,
      params.orgId,
      params.policies,
      capabilities,
    );
    signal.throwIfAborted();
    if (!validation.ok) {
      return validation;
    }

    await ensureOrgModelPolicies(db, params.orgId, params.userId);
    signal.throwIfAborted();

    const now = nowDate();
    await db.transaction(async (tx) => {
      await tx
        .insert(orgModelPolicies)
        .values(
          validation.data.map((policy) => {
            return {
              orgId: params.orgId,
              model: policy.model,
              isDefault: false,
              defaultProviderType: policy.defaultProviderType,
              credentialScope: policy.credentialScope,
              modelProviderId: policy.modelProviderId,
              createdByUserId: params.userId,
              updatedByUserId: params.userId,
              createdAt: now,
              updatedAt: now,
            };
          }),
        )
        .onConflictDoNothing({
          target: [orgModelPolicies.orgId, orgModelPolicies.model],
        });

      const removedRows = await tx
        .delete(orgModelPolicies)
        .where(
          and(
            eq(orgModelPolicies.orgId, params.orgId),
            inArray(orgModelPolicies.model, [...SUPPORTED_RUN_MODELS]),
            notInArray(
              orgModelPolicies.model,
              validation.data.map((policy) => {
                return policy.model;
              }),
            ),
          ),
        )
        .returning({ model: orgModelPolicies.model });

      const removedModels = removedRows.map((row) => {
        return row.model;
      });
      const defaultPolicy = validation.data.find((policy) => {
        return policy.isDefault;
      });
      if (removedModels.length > 0 && defaultPolicy) {
        await tx
          .update(orgMembersMetadata)
          .set({ selectedModel: defaultPolicy.model, updatedAt: now })
          .where(
            and(
              eq(orgMembersMetadata.orgId, params.orgId),
              inArray(orgMembersMetadata.selectedModel, removedModels),
            ),
          );
      }

      await tx
        .update(orgModelPolicies)
        .set({ isDefault: false })
        .where(eq(orgModelPolicies.orgId, params.orgId));

      for (const policy of validation.data) {
        await tx
          .update(orgModelPolicies)
          .set({
            isDefault: policy.isDefault,
            defaultProviderType: policy.defaultProviderType,
            credentialScope: policy.credentialScope,
            modelProviderId: policy.modelProviderId,
            updatedAt: now,
            updatedByUserId: params.userId,
          })
          .where(
            and(
              eq(orgModelPolicies.orgId, params.orgId),
              eq(orgModelPolicies.model, policy.model),
            ),
          );
      }
    });
    signal.throwIfAborted();

    const response = await listOrgModelPolicies(
      db,
      params.orgId,
      params.userId,
    );
    signal.throwIfAborted();
    return ok(response);
  },
);
