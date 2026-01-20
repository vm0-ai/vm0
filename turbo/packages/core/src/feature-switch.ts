/**
 * Feature switch system
 *
 * Provides centralized feature flag management with support for
 * future user-identity based overrides.
 */

import { FeatureSwitchKey } from "./feature-switch-key";

/**
 * Feature switch definition
 */
export interface FeatureSwitch {
  readonly key: FeatureSwitchKey;
  readonly maintainer: string;
  readonly enabled: boolean;
}

/**
 * Pricing feature switch
 */
export const PricingSwitch: FeatureSwitch = {
  key: FeatureSwitchKey.Pricing,
  maintainer: "ethan@vm0.ai",
  enabled: false,
};

/**
 * Registry of all feature switches
 */
const FEATURE_SWITCHES: Record<FeatureSwitchKey, FeatureSwitch> = {
  [FeatureSwitchKey.Pricing]: PricingSwitch,
};

/**
 * Get a feature switch by key
 */
export function getFeatureSwitch(key: FeatureSwitchKey): FeatureSwitch {
  return FEATURE_SWITCHES[key];
}

/**
 * Check if a feature is enabled
 *
 * Returns a Promise to support future user-identity based overrides.
 */
export async function isFeatureEnabled(
  key: FeatureSwitchKey,
): Promise<boolean> {
  const featureSwitch = getFeatureSwitch(key);
  return Promise.resolve(featureSwitch.enabled);
}
