import {
  VM0_MODEL_TO_PROVIDER,
  getVm0ModelFeatureFlag,
} from "@vm0/api-contracts/contracts/model-providers";
import { badRequest, notFound } from "@vm0/api-services/errors";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { loadFeatureSwitchOverrides } from "../user/feature-switches-service";

export async function assertVm0SelectedModelEnabled(args: {
  orgId: string;
  userId: string;
  selectedModel: string | undefined;
}): Promise<void> {
  const { orgId, userId, selectedModel } = args;
  if (!selectedModel) return;
  if (!(selectedModel in VM0_MODEL_TO_PROVIDER)) {
    throw badRequest(`Unknown VM0 model "${selectedModel}"`);
  }

  const featureFlag = getVm0ModelFeatureFlag(selectedModel);
  if (!featureFlag) return;

  const overrides = await loadFeatureSwitchOverrides(orgId, userId);
  const enabled = isFeatureEnabled(featureFlag, {
    orgId,
    userId,
    overrides,
  });
  if (!enabled) {
    throw notFound(`VM0 model "${selectedModel}" is not available`);
  }
}
