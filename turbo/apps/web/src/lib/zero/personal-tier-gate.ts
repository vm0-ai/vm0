import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { loadFeatureSwitchOverrides } from "./user/feature-switches-service";

/**
 * Personal-tier eligibility for Epic #11868. Resolves to true only when
 * BOTH conditions hold:
 *   1. caller opted in via the agent/schedule `prefer_personal_provider`
 *      flag (or the equivalent at any other call site), AND
 *   2. the `personalModelProvider` feature switch is on for the caller
 *      (staff-only by default; per-user override flips it for tests and
 *      gradual rollout).
 *
 * Loads the per-user feature switch overrides only when the flag is true
 * so the common (flag=false) path stays free of the DB read.
 *
 * Consumed by the resolver (`context/resolve-model-provider.ts`),
 * admission (`zero-run-policy.ts`), and the chat-thread eager-pin
 * (`app/api/zero/chat/messages/route.ts`). The shared module retires
 * the file-private duplicate that lived in two of those files prior to
 * the third call site landing.
 */
export async function isPersonalTierEligible(
  orgId: string,
  userId: string,
  preferPersonalProvider: boolean | undefined,
): Promise<boolean> {
  if (!preferPersonalProvider) return false;
  const overrides = await loadFeatureSwitchOverrides(orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.PersonalModelProvider, {
    orgId,
    userId,
    overrides,
  });
}
