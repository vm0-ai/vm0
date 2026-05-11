import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import {
  getCanonicalModelDisplayName,
  getVm0VisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { loadFeatureSwitchOverrides } from "../user/feature-switches-service";
import { ensureOrgModelPolicies } from "./org-model-policy-service";
import { resolveModelFirstRouteDescriptor } from "./model-first-route-service";
import { getUserModelPreferenceModel } from "./user-model-preference-service";

export interface ModelPreferencePickerOption {
  model: SupportedRunModel;
  label: string;
  isDefault: boolean;
}

export interface ModelPreferencePickerState {
  enabled: boolean;
  options: ModelPreferencePickerOption[];
  currentSelectedModel: SupportedRunModel | null;
  workspaceDefaultModel: SupportedRunModel | null;
  workspaceDefaultName: string | null;
}

async function canUseModelRoute(params: {
  orgId: string;
  userId: string;
  model: SupportedRunModel;
}): Promise<boolean> {
  try {
    await resolveModelFirstRouteDescriptor({
      orgId: params.orgId,
      userId: params.userId,
      selectedModel: params.model,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getModelPreferencePickerState(params: {
  orgId: string;
  userId: string;
}): Promise<ModelPreferencePickerState> {
  const overrides = await loadFeatureSwitchOverrides(
    params.orgId,
    params.userId,
  );
  const featureStates = getAllFeatureStates({
    orgId: params.orgId,
    userId: params.userId,
    overrides,
  });

  if (!featureStates[FeatureSwitchKey.ModelFirstModelProvider]) {
    return {
      enabled: false,
      options: [],
      currentSelectedModel: null,
      workspaceDefaultModel: null,
      workspaceDefaultName: null,
    };
  }

  const visibleModels = new Set(getVm0VisibleModels(featureStates));
  const policies = await ensureOrgModelPolicies(params.orgId, params.userId);
  const currentSelectedModel = await getUserModelPreferenceModel(
    params.orgId,
    params.userId,
  );

  const options: ModelPreferencePickerOption[] = [];
  for (const policy of policies) {
    if (
      !isSupportedRunModel(policy.model) ||
      !visibleModels.has(policy.model)
    ) {
      continue;
    }
    if (
      !(await canUseModelRoute({
        orgId: params.orgId,
        userId: params.userId,
        model: policy.model,
      }))
    ) {
      continue;
    }
    options.push({
      model: policy.model,
      label: getCanonicalModelDisplayName(policy.model),
      isDefault: policy.isDefault,
    });
  }

  const workspaceDefaultModel =
    options.find((option) => {
      return option.isDefault;
    })?.model ?? null;

  return {
    enabled: true,
    options,
    currentSelectedModel,
    workspaceDefaultModel,
    workspaceDefaultName: workspaceDefaultModel
      ? getCanonicalModelDisplayName(workspaceDefaultModel)
      : null,
  };
}
