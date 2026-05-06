import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { loadFeatureSwitchOverrides } from "../user/feature-switches-service";

/**
 * Eligibility gate for the ChatGPT OAuth model provider (Epic #11872).
 *
 * Single seam consumed by downstream sub-issues to gate the new provider's
 * UI tile, server routes that initiate the OAuth dance, and stale-provider
 * banner suppression. Returning false MUST hide the entire surface so the
 * new provider type does not leak into UI or API responses.
 */
export async function isCodexOauthEligible(
  orgId: string,
  userId: string,
): Promise<boolean> {
  const overrides = await loadFeatureSwitchOverrides(orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.CodexOauthProvider, {
    orgId,
    userId,
    overrides,
  });
}
