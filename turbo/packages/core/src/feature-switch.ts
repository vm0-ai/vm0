/**
 * Feature switch system
 *
 * Provides centralized feature flag management with support for
 * future user-identity based overrides.
 */

import { FeatureSwitchKey } from "./feature-switch-key";

export interface FeatureSwitch {
  readonly maintainer: string;
  readonly enabled: boolean;
}

/**
 * Registry of all feature switches
 */
const FEATURE_SWITCHES: Record<FeatureSwitchKey, FeatureSwitch> = {
  [FeatureSwitchKey.Pricing]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.Dummy]: {
    maintainer: "ethan@vm0.ai",
    enabled: true,
  },
  [FeatureSwitchKey.PlatformAgents]: {
    maintainer: "ethan@vm0.ai",
    enabled: true,
  },
  [FeatureSwitchKey.PlatformSecrets]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.PlatformArtifacts]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.PlatformApiKeys]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.AgentDetailPage]: {
    maintainer: "yuma@vm0.ai",
    enabled: false,
  },
};

/**
 * Check if a feature is enabled
 *
 * Returns a Promise to support future user-identity based overrides.
 */
export async function isFeatureEnabled(
  key: FeatureSwitchKey,
): Promise<boolean> {
  const featureSwitch = FEATURE_SWITCHES[key];
  return Promise.resolve(featureSwitch.enabled);
}
