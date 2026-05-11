import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  getCanonicalModelDisplayName,
  getVm0VisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { loadFeatureSwitchOverrides } from "../user/feature-switches-service";
import { ensureOrgModelPolicies } from "../model-policy/org-model-policy-service";
import { resolveModelFirstRouteDescriptor } from "../model-policy/model-first-route-service";
import { getUserModelPreferenceModel } from "../model-policy/user-model-preference-service";

interface SlackModelPickerOption {
  model: SupportedRunModel;
  label: string;
  isDefault: boolean;
}

interface SlackModelPickerState {
  enabled: boolean;
  options: SlackModelPickerOption[];
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

export async function getSlackModelPickerState(params: {
  orgId: string;
  userId: string;
}): Promise<SlackModelPickerState> {
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

  const options: SlackModelPickerOption[] = [];
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
