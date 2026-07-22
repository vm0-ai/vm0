import {
  getFrameworkForType,
  getVm0ConcreteProviderType,
  isCodexFastModeModel,
  isLimitedFree1RestrictedRunModel,
  isSupportedRunModel,
  isModelSupportedByProvider,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import type { SupportedFramework } from "@vm0/core/frameworks";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { and, eq, or } from "drizzle-orm";

import { badRequestMessage, insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import { ensureOrgModelPolicies } from "./zero-model-policy.service";
import { checkOrgCreditsForRunAdmission } from "./zero-run-admission.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";

const ORG_SENTINEL_USER_ID = "__org__";
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export interface ModelFirstPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

interface ResolvedModelFirstPolicyRoute {
  readonly modelProviderId: string | null;
  readonly modelProviderType: ModelProviderType;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: SupportedRunModel;
  readonly cliAgentType: SupportedFramework;
}

interface PersistedModelFirstRouteResolution {
  readonly route: ResolvedModelFirstPolicyRoute | null;
  readonly selectedModelChanged: boolean;
}

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

interface AvailableModelProviderPin {
  readonly type: string;
}

function modelFirstPinFromRoute(
  route: ResolvedModelFirstPolicyRoute,
): ModelFirstPin {
  return {
    modelProviderId: route.modelProviderId,
    modelProviderType: route.modelProviderType,
    modelProviderCredentialScope: route.modelProviderCredentialScope,
    selectedModel: route.selectedModel,
  };
}

function isOAuthMemberProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
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

function modelAllowedForOrgPlan(args: {
  readonly capabilities: Pick<OrgPlanCapabilities, "restrictedVm0Models">;
  readonly selectedModel: string | null | undefined;
}): boolean {
  return (
    !args.capabilities.restrictedVm0Models ||
    !isLimitedFree1RestrictedRunModel(args.selectedModel)
  );
}

function modelProviderAllowedForOrgPlan(args: {
  readonly capabilities: Pick<OrgPlanCapabilities, "supportByok">;
  readonly modelProviderType: string | null | undefined;
}): boolean {
  return args.capabilities.supportByok || args.modelProviderType === "vm0";
}

function parseModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null || value === "org" || value === "member") {
    return value;
  }
  throw new Error(`Unknown model provider credential scope "${value}"`);
}

function cliAgentTypeForPolicyRoute(
  providerType: ModelProviderType,
  selectedModel: SupportedRunModel,
): SupportedFramework {
  return getFrameworkForType(
    providerType === "vm0"
      ? getVm0ConcreteProviderType(selectedModel)
      : providerType,
  );
}

async function resolveValidPolicyRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedVm0Models" | "supportByok"
  >;
  readonly selectedModel: string;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  if (
    !isSupportedRunModel(params.selectedModel) ||
    !modelAllowedForOrgPlan({
      capabilities: params.capabilities,
      selectedModel: params.selectedModel,
    })
  ) {
    return null;
  }

  const [policy] = await params.db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, params.orgId),
        eq(orgModelPolicies.model, params.selectedModel),
      ),
    )
    .limit(1);
  const providerType = policy
    ? modelProviderTypeSchema.safeParse(policy.defaultProviderType)
    : null;
  if (
    !policy ||
    !isSupportedRunModel(policy.model) ||
    !providerType?.success ||
    !isModelSupportedByProvider(policy.model, providerType.data) ||
    !modelProviderAllowedForOrgPlan({
      capabilities: params.capabilities,
      modelProviderType: providerType.data,
    })
  ) {
    return null;
  }

  const credentialScope = parseModelProviderCredentialScope(
    policy.credentialScope,
  );
  if (credentialScope === null) {
    return null;
  }
  if (credentialScope === "member") {
    if (
      !isOAuthMemberProviderType(providerType.data) ||
      policy.modelProviderId !== null
    ) {
      return null;
    }
  } else if (isOAuthMemberProviderType(providerType.data)) {
    return null;
  } else if (providerType.data === "vm0") {
    if (policy.modelProviderId !== null) {
      return null;
    }
  } else {
    if (policy.modelProviderId === null) {
      return null;
    }
    const [provider] = await params.db
      .select({ type: modelProviders.type })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, policy.modelProviderId),
          eq(modelProviders.orgId, params.orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      )
      .limit(1);
    if (provider?.type !== providerType.data) {
      return null;
    }
  }

  return {
    modelProviderId: policy.modelProviderId,
    modelProviderType: providerType.data,
    modelProviderCredentialScope: credentialScope,
    selectedModel: policy.model,
    cliAgentType: cliAgentTypeForPolicyRoute(providerType.data, policy.model),
  };
}

export async function resolveDefaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
): Promise<ModelFirstPin> {
  if (userId !== "__no_preference__") {
    await ensureOrgModelPolicies(db, orgId, userId);
  }
  const capabilities = await orgModelCapabilities(db, orgId);
  if (userId !== "__no_preference__") {
    const [preference] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);
    if (preference?.selectedModel) {
      const preferredRoute = await resolveValidPolicyRoute({
        db,
        orgId,
        capabilities,
        selectedModel: preference.selectedModel,
      });
      if (preferredRoute) {
        return modelFirstPinFromRoute(preferredRoute);
      }
    }
  }

  const route = await resolveWorkspaceDefaultModelFirstRoute({
    db,
    orgId,
    capabilities,
  });
  return route
    ? modelFirstPinFromRoute(route)
    : {
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: null,
      };
}

async function resolveWorkspaceDefaultModelFirstRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedVm0Models" | "supportByok"
  >;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  const [policy] = await params.db
    .select({ model: orgModelPolicies.model })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, params.orgId),
        eq(orgModelPolicies.isDefault, true),
      ),
    )
    .limit(1);
  if (!policy) {
    return null;
  }
  return resolveValidPolicyRoute({
    db: params.db,
    orgId: params.orgId,
    capabilities: params.capabilities,
    selectedModel: policy.model,
  });
}

export async function resolvePersistedModelFirstRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly selectedModel: string | null;
}): Promise<PersistedModelFirstRouteResolution> {
  await ensureOrgModelPolicies(params.db, params.orgId, params.userId);
  const capabilities = await orgModelCapabilities(params.db, params.orgId);
  const currentRoute = params.selectedModel
    ? await resolveValidPolicyRoute({
        db: params.db,
        orgId: params.orgId,
        capabilities,
        selectedModel: params.selectedModel,
      })
    : null;
  if (currentRoute) {
    return { route: currentRoute, selectedModelChanged: false };
  }

  const defaultRoute = await resolveWorkspaceDefaultModelFirstRoute({
    db: params.db,
    orgId: params.orgId,
    capabilities,
  });
  return {
    route: defaultRoute,
    selectedModelChanged:
      defaultRoute !== null &&
      defaultRoute.selectedModel !== params.selectedModel,
  };
}

async function loadAvailableModelProviderPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string;
}): Promise<AvailableModelProviderPin | null> {
  const [provider] = await params.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);
  return provider ?? null;
}

export async function resolveModelSelectionPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: ModelSelectionRequest;
}): Promise<
  | ModelFirstPin
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof insufficientCredits>
> {
  const { db, orgId, userId, modelSelection } = params;
  const capabilities = await orgModelCapabilities(db, orgId);
  if (
    !modelAllowedForOrgPlan({
      capabilities,
      selectedModel: modelSelection.selectedModel,
    })
  ) {
    return insufficientCredits();
  }
  if (modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID) {
    const provider = await loadAvailableModelProviderPin({
      db,
      orgId,
      userId,
      modelProviderId: modelSelection.modelProviderId,
    });
    if (!provider) {
      return badRequestMessage("Unknown model provider for this workspace");
    }
    if (
      !modelProviderAllowedForOrgPlan({
        capabilities,
        modelProviderType: provider.type,
      })
    ) {
      return insufficientCredits();
    }
    if (
      provider.type === "vm0" &&
      !isSupportedRunModel(modelSelection.selectedModel)
    ) {
      return badRequestMessage("Invalid model selection");
    }
    return {
      modelProviderId: modelSelection.modelProviderId,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }

  if (!isSupportedRunModel(modelSelection.selectedModel)) {
    return badRequestMessage("Invalid model selection");
  }

  await ensureOrgModelPolicies(db, orgId, userId);
  const route = await resolveValidPolicyRoute({
    db,
    orgId,
    capabilities,
    selectedModel: modelSelection.selectedModel,
  });
  return route
    ? modelFirstPinFromRoute(route)
    : badRequestMessage(
        "The selected model is not available in this workspace",
      );
}

async function resolveEffectiveModelProviderType(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<string | null | undefined> {
  if (params.modelPin.modelProviderType) {
    return params.modelPin.modelProviderType;
  }
  if (!params.modelPin.modelProviderId) {
    return params.requestedModelProvider;
  }

  const [provider] = await params.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelPin.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);

  return provider?.type ?? params.requestedModelProvider;
}

export async function resolveModelFirstProviderAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<{
  readonly effectiveModelProvider: string | null | undefined;
  readonly cliAgentType: SupportedFramework | null;
  readonly error:
    | Awaited<ReturnType<typeof checkOrgCreditsForRunAdmission>>
    | ReturnType<typeof badRequestMessage>;
}> {
  const effectiveModelProvider =
    await resolveEffectiveModelProviderType(params);
  const selectedModel = params.modelPin.selectedModel;
  const parsedProvider = modelProviderTypeSchema.safeParse(
    effectiveModelProvider,
  );
  const knownProvider = parsedProvider.success ? parsedProvider.data : null;
  const cliAgentType = knownProvider
    ? getFrameworkForType(
        knownProvider === "vm0" && isSupportedRunModel(selectedModel)
          ? getVm0ConcreteProviderType(selectedModel)
          : knownProvider,
      )
    : null;
  if (
    isSupportedRunModel(selectedModel) &&
    (!knownProvider ||
      !isModelSupportedByProvider(selectedModel, knownProvider))
  ) {
    return {
      effectiveModelProvider,
      cliAgentType,
      error: badRequestMessage(
        "The selected model is not supported by the current model provider",
      ),
    };
  }
  const error = await checkOrgCreditsForRunAdmission({
    db: params.db,
    orgId: params.orgId,
    modelProviderType: effectiveModelProvider,
    selectedModel,
  });
  return { effectiveModelProvider, cliAgentType, error };
}

export function isCodexFastServiceTierSupported(params: {
  readonly selectedModel: string | null | undefined;
  readonly effectiveModelProvider: string | null | undefined;
  readonly codexFastModeEnabled: boolean;
}): boolean {
  return (
    params.codexFastModeEnabled &&
    params.effectiveModelProvider === "codex-oauth-token" &&
    isCodexFastModeModel(params.selectedModel)
  );
}
