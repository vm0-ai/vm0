import {
  allowsCustomModel,
  getDefaultModel,
  getModels,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { isPersonalTierEligible } from "../personal-tier-gate";
import { getUserAnyDefaultModelProvider } from "./model-provider-service";

interface ModelProviderPin {
  modelProviderId: string | null;
  selectedModel: string | null;
}

interface ResolvePreferredModelProviderPinParams {
  orgId: string;
  userId: string;
  preferPersonalProvider: boolean;
  fallback: ModelProviderPin;
}

function canProviderUseModel(
  type: ModelProviderType,
  model: string | null | undefined,
): model is string {
  if (!model) {
    return false;
  }
  if (allowsCustomModel(type)) {
    return true;
  }
  return getModels(type)?.includes(model) ?? false;
}

function resolveProviderSelectedModel(
  type: ModelProviderType,
  selectedModel: string | null,
  fallbackSelectedModel: string | null,
): string | null {
  if (selectedModel) {
    return selectedModel;
  }
  if (canProviderUseModel(type, fallbackSelectedModel)) {
    return fallbackSelectedModel;
  }
  return getDefaultModel(type) ?? null;
}

/**
 * Resolve the model-provider pin for user-facing agent triggers that should
 * prefer the caller's personal default provider when the agent opts in.
 *
 * The personal tier has one default per `(orgId, userId)`, so the
 * cross-framework fallback intentionally uses the user's single default and
 * lets the downstream provider resolver derive the effective framework.
 */
export async function resolvePreferredModelProviderPin(
  params: ResolvePreferredModelProviderPinParams,
): Promise<ModelProviderPin> {
  const personalEligible = await isPersonalTierEligible(
    params.orgId,
    params.userId,
    params.preferPersonalProvider,
  );
  if (!personalEligible) {
    return params.fallback;
  }

  const userRow = await getUserAnyDefaultModelProvider(
    params.orgId,
    params.userId,
  );
  if (!userRow) {
    return params.fallback;
  }

  return {
    modelProviderId: userRow.id,
    selectedModel: resolveProviderSelectedModel(
      userRow.type,
      userRow.selectedModel,
      params.fallback.selectedModel,
    ),
  };
}
