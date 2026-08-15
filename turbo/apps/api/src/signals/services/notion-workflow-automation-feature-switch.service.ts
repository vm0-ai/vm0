import { computed } from "ccstate";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";

import { userFeatureSwitchOverrides } from "./feature-switches.service";

export function notionWorkflowAutomationCreationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.NotionWorkflowAutomations, {
      orgId,
      userId,
      overrides,
    });
  });
}
