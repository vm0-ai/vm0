import { computed } from "ccstate";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";

export { FeatureSwitchKey } from "@vm0/core";

/**
 * Create a computed signal to check if a feature is enabled
 *
 * @param key - The feature switch key to check
 * @returns A computed signal that resolves to the enabled state
 */
export function isEnabled(key: FeatureSwitchKey) {
  return computed(async () => {
    return await isFeatureEnabled(key);
  });
}
