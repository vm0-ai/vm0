import {
  getFrameworkForType,
  getCanonicalRetiredRunModel,
  getRetiredRunModelReplacement,
  getVm0ConcreteProviderType,
  isCodexFastModeModel,
  isLimitedFree1RestrictedRunModel,
  isRetiredRunModel,
  isSupportedRunModel,
  isModelSupportedByProvider,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  getModelProviderTypeForSurfaceProtocol,
  modelProviderSurfaceProtocolSchema,
} from "@vm0/api-contracts/contracts/zero-model-provider-gateways";
import type { ChatThreadServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import type { SupportedFramework } from "@vm0/core/frameworks";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { modelProviders } from "@vm0/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@vm0/db/schema/model-provider-gateway";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { and, eq, or } from "drizzle-orm";

import {
  badRequestMessage,
  insufficientCredits,
  modelRetired,
} from "../../lib/error";
import type { Db } from "../external/db";
import { ensureOrgModelPolicies } from "./zero-model-policy.service";
import { checkOrgCreditsForRunAdmission } from "./zero-run-admission.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

const ORG_SENTINEL_USER_ID = "__org__";
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export interface ModelFirstPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

export interface DefaultModelFirstPin extends ModelFirstPin {
  readonly serviceTier: ChatThreadServiceTier | null;
}

interface ResolvedModelFirstPolicyRoute {
  readonly modelProviderId: string | null;
  readonly modelProviderType: ModelProviderType;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: SupportedRunModel;
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

interface StoredModelPolicyRoute {
  readonly model: string;
  readonly defaultProviderType: string;
  readonly credentialScope: string;
  readonly modelProviderId: string | null;
  readonly modelProviderSurfaceId: string | null;
}

function providerTypeForSurfaceProtocol(
  protocol: string,
): ModelProviderType | null {
  const parsed = modelProviderSurfaceProtocolSchema.safeParse(protocol);
  return parsed.success
    ? getModelProviderTypeForSurfaceProtocol(parsed.data)
    : null;
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

async function resolveCustomSurfacePolicyRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly policy: {
    readonly model: SupportedRunModel;
    readonly modelProviderId: string | null;
    readonly modelProviderSurfaceId: string;
  };
  readonly providerType: ModelProviderType;
  readonly credentialScope: ModelProviderCredentialScope;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  if (
    params.credentialScope !== "org" ||
    params.policy.modelProviderId !== null ||
    isOAuthMemberProviderType(params.providerType)
  ) {
    return null;
  }
  const [surface] = await params.db
    .select({
      protocol: modelProviderSurfaces.protocol,
      modelMappings: modelProviderSurfaces.modelMappings,
    })
    .from(modelProviderSurfaces)
    .innerJoin(
      modelProviderConnections,
      eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
    )
    .where(
      and(
        eq(modelProviderSurfaces.id, params.policy.modelProviderSurfaceId),
        eq(modelProviderConnections.orgId, params.orgId),
      ),
    )
    .limit(1);
  if (
    !surface ||
    providerTypeForSurfaceProtocol(surface.protocol) !== params.providerType ||
    typeof surface.modelMappings[params.policy.model] !== "string"
  ) {
    return null;
  }
  return {
    modelProviderId: params.policy.modelProviderSurfaceId,
    modelProviderType: params.providerType,
    modelProviderCredentialScope: params.credentialScope,
    selectedModel: params.policy.model,
  };
}

function isLegacyPolicyRouteShapeValid(params: {
  readonly credentialScope: ModelProviderCredentialScope;
  readonly providerType: ModelProviderType;
  readonly modelProviderId: string | null;
}): boolean {
  if (params.credentialScope === "member") {
    return (
      isOAuthMemberProviderType(params.providerType) &&
      params.modelProviderId === null
    );
  }
  if (isOAuthMemberProviderType(params.providerType)) {
    return false;
  }
  return params.providerType === "vm0"
    ? params.modelProviderId === null
    : params.modelProviderId !== null;
}

function getLegacyOrgProviderId(params: {
  readonly credentialScope: ModelProviderCredentialScope;
  readonly providerType: ModelProviderType;
  readonly modelProviderId: string | null;
}): string | null {
  return params.credentialScope === "org" && params.providerType !== "vm0"
    ? params.modelProviderId
    : null;
}

async function loadModelPolicyRoute(
  db: Db,
  orgId: string,
  model: string,
): Promise<StoredModelPolicyRoute | null> {
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
      modelProviderSurfaceId: orgModelPolicies.modelProviderSurfaceId,
    })
    .from(orgModelPolicies)
    .where(
      and(eq(orgModelPolicies.orgId, orgId), eq(orgModelPolicies.model, model)),
    )
    .limit(1);
  return policy ?? null;
}

async function resolvePolicyRowForModel(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedVm0Models" | "supportByok"
  >;
  readonly policy: StoredModelPolicyRoute;
  readonly selectedModel: SupportedRunModel;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  const providerType = modelProviderTypeSchema.safeParse(
    params.policy.defaultProviderType,
  );
  if (
    isRetiredRunModel(params.selectedModel) ||
    !modelAllowedForOrgPlan({
      capabilities: params.capabilities,
      selectedModel: params.selectedModel,
    }) ||
    !providerType.success ||
    (!params.policy.modelProviderSurfaceId &&
      !isModelSupportedByProvider(params.selectedModel, providerType.data)) ||
    !modelProviderAllowedForOrgPlan({
      capabilities: params.capabilities,
      modelProviderType: providerType.data,
    })
  ) {
    return null;
  }

  const credentialScope = parseModelProviderCredentialScope(
    params.policy.credentialScope,
  );
  if (credentialScope === null) {
    return null;
  }
  if (params.policy.modelProviderSurfaceId) {
    return await resolveCustomSurfacePolicyRoute({
      db: params.db,
      orgId: params.orgId,
      policy: {
        model: params.selectedModel,
        modelProviderId: params.policy.modelProviderId,
        modelProviderSurfaceId: params.policy.modelProviderSurfaceId,
      },
      providerType: providerType.data,
      credentialScope,
    });
  }
  if (
    !isLegacyPolicyRouteShapeValid({
      credentialScope,
      providerType: providerType.data,
      modelProviderId: params.policy.modelProviderId,
    })
  ) {
    return null;
  }
  const legacyOrgProviderId = getLegacyOrgProviderId({
    credentialScope,
    providerType: providerType.data,
    modelProviderId: params.policy.modelProviderId,
  });
  if (legacyOrgProviderId) {
    const [provider] = await params.db
      .select({ type: modelProviders.type })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, legacyOrgProviderId),
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
    modelProviderId: params.policy.modelProviderId,
    modelProviderType: providerType.data,
    modelProviderCredentialScope: credentialScope,
    selectedModel: params.selectedModel,
  };
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
    isRetiredRunModel(params.selectedModel)
  ) {
    return null;
  }
  const policy = await loadModelPolicyRoute(
    params.db,
    params.orgId,
    params.selectedModel,
  );
  return policy
    ? resolvePolicyRowForModel({
        ...params,
        policy,
        selectedModel: params.selectedModel,
      })
    : null;
}

function builtInModelRoute(
  selectedModel: SupportedRunModel,
): ResolvedModelFirstPolicyRoute {
  return {
    modelProviderId: null,
    modelProviderType: "vm0",
    modelProviderCredentialScope: "org",
    selectedModel,
  };
}

async function resolveStoredModelFirstRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedVm0Models" | "supportByok"
  >;
  readonly selectedModel: string;
  readonly modelProviderType?: string | null;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  const replacement = getRetiredRunModelReplacement(params.selectedModel, {
    restrictedVm0Models: params.capabilities.restrictedVm0Models,
    modelProviderType: params.modelProviderType,
  });
  if (!replacement) {
    return resolveValidPolicyRoute(params);
  }

  const configuredReplacement = await resolveValidPolicyRoute({
    ...params,
    selectedModel: replacement,
  });
  if (configuredReplacement) {
    return configuredReplacement;
  }

  const retiredModel = getCanonicalRetiredRunModel(params.selectedModel);
  const retiredPolicy = retiredModel
    ? await loadModelPolicyRoute(params.db, params.orgId, retiredModel)
    : null;
  const preservedRoute = retiredPolicy
    ? await resolvePolicyRowForModel({
        ...params,
        policy: retiredPolicy,
        selectedModel: replacement,
      })
    : null;
  return preservedRoute ?? builtInModelRoute(replacement);
}

export async function resolveDefaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
): Promise<DefaultModelFirstPin> {
  if (userId !== "__no_preference__") {
    await ensureOrgModelPolicies(db, orgId, userId);
  }
  const capabilities = await orgModelCapabilities(db, orgId);
  if (userId !== "__no_preference__") {
    const [preference] = await db
      .select({
        selectedModel: orgMembersMetadata.selectedModel,
        serviceTier: orgMembersMetadata.serviceTier,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);
    if (preference?.selectedModel) {
      const preferredRoute = await resolveStoredModelFirstRoute({
        db,
        orgId,
        capabilities,
        selectedModel: preference.selectedModel,
      });
      if (preferredRoute) {
        const featureSwitchContext =
          preference.serviceTier === "priority"
            ? await loadUserFeatureSwitchContext(db, orgId, userId)
            : null;
        const serviceTier = isCodexFastServiceTierSupported({
          selectedModel: preferredRoute.selectedModel,
          codexFastModeEnabled:
            featureSwitchContext !== null &&
            isFeatureEnabled(
              FeatureSwitchKey.CodexFastMode,
              featureSwitchContext,
            ),
        })
          ? "priority"
          : null;
        return { ...modelFirstPinFromRoute(preferredRoute), serviceTier };
      }
    }
  }

  const route = await resolveWorkspaceDefaultModelFirstRoute({
    db,
    orgId,
    capabilities,
  });
  return route
    ? { ...modelFirstPinFromRoute(route), serviceTier: null }
    : {
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: null,
        serviceTier: null,
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
  return resolveStoredModelFirstRoute({
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
  readonly modelProviderType?: string | null;
}): Promise<PersistedModelFirstRouteResolution> {
  await ensureOrgModelPolicies(params.db, params.orgId, params.userId);
  const capabilities = await orgModelCapabilities(params.db, params.orgId);
  const currentRoute = params.selectedModel
    ? await resolveStoredModelFirstRoute({
        db: params.db,
        orgId: params.orgId,
        capabilities,
        selectedModel: params.selectedModel,
        modelProviderType: params.modelProviderType,
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
  | ReturnType<typeof modelRetired>
> {
  const { db, orgId, userId, modelSelection } = params;
  const capabilities = await orgModelCapabilities(db, orgId);
  const replacement = getRetiredRunModelReplacement(
    modelSelection.selectedModel,
    { restrictedVm0Models: capabilities.restrictedVm0Models },
  );
  if (replacement) {
    return modelRetired(modelSelection.selectedModel, replacement);
  }
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
    const providerReplacement = getRetiredRunModelReplacement(
      modelSelection.selectedModel,
      {
        restrictedVm0Models: capabilities.restrictedVm0Models,
        modelProviderType: provider.type,
      },
    );
    if (providerReplacement) {
      return modelRetired(modelSelection.selectedModel, providerReplacement);
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
    | ReturnType<typeof badRequestMessage>
    | ReturnType<typeof modelRetired>;
}> {
  const effectiveModelProvider =
    await resolveEffectiveModelProviderType(params);
  const selectedModel = params.modelPin.selectedModel;
  if (isRetiredRunModel(selectedModel, effectiveModelProvider)) {
    const capabilities = await orgModelCapabilities(params.db, params.orgId);
    const replacement = getRetiredRunModelReplacement(selectedModel, {
      restrictedVm0Models: capabilities.restrictedVm0Models,
      modelProviderType: effectiveModelProvider,
    });
    if (replacement) {
      return {
        effectiveModelProvider,
        cliAgentType: null,
        error: modelRetired(selectedModel ?? "Z.AI", replacement),
      };
    }
  }
  const [customSurface] =
    params.modelPin.modelProviderId === null
      ? []
      : await params.db
          .select({
            protocol: modelProviderSurfaces.protocol,
            modelMappings: modelProviderSurfaces.modelMappings,
          })
          .from(modelProviderSurfaces)
          .innerJoin(
            modelProviderConnections,
            eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
          )
          .where(
            and(
              eq(modelProviderSurfaces.id, params.modelPin.modelProviderId),
              eq(modelProviderConnections.orgId, params.orgId),
            ),
          )
          .limit(1);
  const customSurfaceProviderType = customSurface
    ? providerTypeForSurfaceProtocol(customSurface.protocol)
    : null;
  const usesCustomSurface =
    customSurfaceProviderType !== null &&
    customSurfaceProviderType === effectiveModelProvider &&
    isSupportedRunModel(selectedModel) &&
    typeof customSurface?.modelMappings[selectedModel] === "string";
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
    !usesCustomSurface &&
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
    userId: params.userId,
    modelProviderType: effectiveModelProvider,
    selectedModel,
  });
  return { effectiveModelProvider, cliAgentType, error };
}

export function isCodexFastServiceTierSupported(params: {
  readonly selectedModel: string | null | undefined;
  readonly codexFastModeEnabled: boolean;
}): boolean {
  return (
    params.codexFastModeEnabled && isCodexFastModeModel(params.selectedModel)
  );
}

export async function validateCodexServiceTier(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly pin: ModelFirstPin;
  readonly codexServiceTier: "fast" | null;
}): Promise<ReturnType<typeof badRequestMessage> | undefined> {
  if (params.codexServiceTier !== "fast") {
    return undefined;
  }
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    params.db,
    params.orgId,
    params.userId,
  );
  if (!isFeatureEnabled(FeatureSwitchKey.CodexFastMode, featureSwitchContext)) {
    return badRequestMessage(
      "Codex fast mode is not enabled for this workspace",
    );
  }
  if (
    isCodexFastServiceTierSupported({
      selectedModel: params.pin.selectedModel,
      codexFastModeEnabled: true,
    })
  ) {
    return undefined;
  }
  return badRequestMessage(
    "Codex fast mode is only available for GPT 5.6 runs",
  );
}
