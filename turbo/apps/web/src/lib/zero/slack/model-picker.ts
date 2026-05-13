import {
  getCanonicalModelDisplayName,
  getVm0VisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
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
  const visibleModels = new Set(getVm0VisibleModels());
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

  return {
    enabled: true,
    options,
    currentSelectedModel,
  };
}
