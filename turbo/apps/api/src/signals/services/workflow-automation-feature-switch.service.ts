import { computed } from "ccstate";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { userFeatureSwitchOverrides } from "./feature-switches.service";

export function workflowAutomationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.WorkflowAutomation, {
      orgId,
      userId,
      overrides,
    });
  });
}

export function workflowWebhookTriggerCreationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    const context = {
      orgId,
      userId,
      overrides,
    };
    return (
      isFeatureEnabled(FeatureSwitchKey.WorkflowAutomation, context) &&
      isFeatureEnabled(FeatureSwitchKey.WorkflowWebhookTriggers, context)
    );
  });
}
