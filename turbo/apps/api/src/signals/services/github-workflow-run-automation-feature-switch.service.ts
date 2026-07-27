import { computed } from "ccstate";

import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { userFeatureSwitchOverrides } from "./feature-switches.service";

export function githubWorkflowRunAutomationCreationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.GithubWorkflowRunAutomations, {
      orgId,
      userId,
      overrides,
    });
  });
}
