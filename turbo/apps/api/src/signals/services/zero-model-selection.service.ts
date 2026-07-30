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
import {
  getModelProviderTypeForSurfaceProtocol,
  modelProviderSurfaceProtocolSchema,
} from "@vm0/api-contracts/contracts/zero-model-provider-gateways";
import type { SupportedFramework } from "@vm0/core/frameworks";
import { modelProviders } from "@vm0/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@vm0/db/schema/model-provider-gateway";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { and, eq, or, sql } from "drizzle-orm";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { badRequestMessage, insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import { ensureOrgModelPolicies } from "./zero-model-policy.service";
import { modelProviderGatewaySchemaAvailable } from "./model-provider-gateway-schema.service";
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

  const gatewaySchemaAvailable = await modelProviderGatewaySchemaAvailable(
    params.db,
  );
  const [policy] = await params.db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
      modelProviderSurfaceId: gatewaySchemaAvailable
        ? orgModelPolicies.modelProviderSurfaceId
        : sql`NULL::uuid`.mapWith(
            nullableDriverValueDecoder(orgModelPolicies.modelProviderSurfaceId),
          ),
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
    (!policy.modelProviderSurfaceId &&
      !isModelSupportedByProvider(policy.model, providerType.data)) ||
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
  if (policy.modelProviderSurfaceId) {
    return await resolveCustomSurfacePolicyRoute({
      db: params.db,
      orgId: params.orgId,
      policy: {
        model: policy.model,
        modelProviderId: policy.modelProviderId,
        modelProviderSurfaceId: policy.modelProviderSurfaceId,
      },
      providerType: providerType.data,
      credentialScope,
    });
  }
  if (
    !isLegacyPolicyRouteShapeValid({
      credentialScope,
      providerType: providerType.data,
      modelProviderId: policy.modelProviderId,
    })
  ) {
    return null;
  }
  const legacyOrgProviderId = getLegacyOrgProviderId({
    credentialScope,
    providerType: providerType.data,
    modelProviderId: policy.modelProviderId,
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
    modelProviderId: policy.modelProviderId,
    modelProviderType: providerType.data,
    modelProviderCredentialScope: credentialScope,
    selectedModel: policy.model,
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
  const gatewaySchemaAvailable = await modelProviderGatewaySchemaAvailable(
    params.db,
  );
  const [customSurface] =
    !gatewaySchemaAvailable || params.modelPin.modelProviderId === null
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
