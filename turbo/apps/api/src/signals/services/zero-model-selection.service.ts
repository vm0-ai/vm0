import {
  SUPPORTED_RUN_MODELS,
  isLimitedFree1RestrictedRunModel,
  isSupportedRunModel,
  type ModelProviderCredentialScope,
} from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { and, eq, inArray, or } from "drizzle-orm";

import { badRequestMessage, insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import { ensureOrgModelPolicies } from "./zero-model-policy.service";
import { checkOrgCreditsForRunAdmission } from "./zero-run-admission.service";

const ORG_SENTINEL_USER_ID = "__org__";
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export interface ModelFirstPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

interface AvailableModelProviderPin {
  readonly type: string;
}

async function orgHasLimitedFree1Restrictions(
  db: Db,
  orgId: string,
): Promise<boolean> {
  const [org] = await db
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return org?.tier === "limited-free-1";
}

function modelAllowedForOrgTier(args: {
  readonly limitedFree1: boolean;
  readonly selectedModel: string | null | undefined;
}): boolean {
  return (
    !args.limitedFree1 || !isLimitedFree1RestrictedRunModel(args.selectedModel)
  );
}

function modelProviderAllowedForOrgTier(args: {
  readonly limitedFree1: boolean;
  readonly modelProviderType: string | null | undefined;
}): boolean {
  return !args.limitedFree1 || args.modelProviderType === "vm0";
}

function parseModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null || value === "org" || value === "member") {
    return value;
  }
  throw new Error(`Unknown model provider credential scope "${value}"`);
}

export function modelOnlyModelFirstPin(
  selectedModel: string | null,
): ModelFirstPin {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel,
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
  const limitedFree1 = await orgHasLimitedFree1Restrictions(db, orgId);
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

  const preferredModel =
    isSupportedRunModel(preference?.selectedModel) &&
    modelAllowedForOrgTier({
      limitedFree1,
      selectedModel: preference.selectedModel,
    })
      ? preference.selectedModel
      : null;
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      preferredModel
        ? and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.model, preferredModel),
          )
        : and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.isDefault, true),
          ),
    )
    .limit(1);

  if (!policy && preferredModel) {
    return resolveDefaultModelFirstPin(db, orgId, "__no_preference__");
  }

  if (
    !policy ||
    !isSupportedRunModel(policy.model) ||
    !modelAllowedForOrgTier({ limitedFree1, selectedModel: policy.model }) ||
    !modelProviderAllowedForOrgTier({
      limitedFree1,
      modelProviderType: policy.defaultProviderType,
    })
  ) {
    const fallbackPolicies = await db
      .select({
        model: orgModelPolicies.model,
        defaultProviderType: orgModelPolicies.defaultProviderType,
        credentialScope: orgModelPolicies.credentialScope,
        modelProviderId: orgModelPolicies.modelProviderId,
      })
      .from(orgModelPolicies)
      .where(
        and(
          eq(orgModelPolicies.orgId, orgId),
          inArray(orgModelPolicies.model, [...SUPPORTED_RUN_MODELS]),
        ),
      )
      .limit(SUPPORTED_RUN_MODELS.length);
    const fallbackPolicy = fallbackPolicies.find((candidate) => {
      return (
        isSupportedRunModel(candidate.model) &&
        modelAllowedForOrgTier({
          limitedFree1,
          selectedModel: candidate.model,
        }) &&
        modelProviderAllowedForOrgTier({
          limitedFree1,
          modelProviderType: candidate.defaultProviderType,
        })
      );
    });
    if (
      fallbackPolicy &&
      isSupportedRunModel(fallbackPolicy.model) &&
      modelAllowedForOrgTier({
        limitedFree1,
        selectedModel: fallbackPolicy.model,
      }) &&
      modelProviderAllowedForOrgTier({
        limitedFree1,
        modelProviderType: fallbackPolicy.defaultProviderType,
      })
    ) {
      return {
        modelProviderId: fallbackPolicy.modelProviderId ?? null,
        modelProviderType: fallbackPolicy.defaultProviderType,
        modelProviderCredentialScope: parseModelProviderCredentialScope(
          fallbackPolicy.credentialScope,
        ),
        selectedModel: fallbackPolicy.model,
      };
    }
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  }

  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
  };
}

export async function modelProviderPinAvailable(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string;
}): Promise<boolean> {
  return (await loadAvailableModelProviderPin(params)) !== null;
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
  const limitedFree1 = await orgHasLimitedFree1Restrictions(db, orgId);
  if (
    !modelAllowedForOrgTier({
      limitedFree1,
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
      !modelProviderAllowedForOrgTier({
        limitedFree1,
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
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.model, modelSelection.selectedModel),
      ),
    )
    .limit(1);
  if (!policy) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }
  if (
    !modelProviderAllowedForOrgTier({
      limitedFree1,
      modelProviderType: policy.defaultProviderType,
    })
  ) {
    return insufficientCredits();
  }
  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
  };
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
  readonly error: Awaited<ReturnType<typeof checkOrgCreditsForRunAdmission>>;
}> {
  const effectiveModelProvider =
    await resolveEffectiveModelProviderType(params);
  const error = await checkOrgCreditsForRunAdmission({
    db: params.db,
    orgId: params.orgId,
    modelProviderType: effectiveModelProvider,
    selectedModel: params.modelPin.selectedModel,
  });
  return { effectiveModelProvider, error };
}
