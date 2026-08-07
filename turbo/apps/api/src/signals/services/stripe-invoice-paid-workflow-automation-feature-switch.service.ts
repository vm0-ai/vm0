import { computed } from "ccstate";

import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import type { ReadonlyDb } from "../external/db";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";

export async function stripeInvoicePaidWorkflowAutomationEnabledForOwnerInDb(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  return isFeatureEnabled(
    FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations,
    await loadUserFeatureSwitchContext(db, orgId, userId),
  );
}

export function stripeInvoicePaidWorkflowAutomationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(
      FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations,
      { orgId, userId, overrides },
    );
  });
}
