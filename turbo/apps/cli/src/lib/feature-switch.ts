import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";

export { FeatureSwitchKey } from "@vm0/core";

/**
 * Check if a feature is enabled
 *
 * @param key - The feature switch key to check
 * @returns A Promise that resolves to the enabled state
 */
export async function isEnabled(key: FeatureSwitchKey): Promise<boolean> {
  return isFeatureEnabled(key);
}
