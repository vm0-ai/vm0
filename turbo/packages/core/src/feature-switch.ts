/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as SHA-1 hashes to avoid exposing plain-text identifiers in source code.
 */

import { FeatureSwitchKey } from "./feature-switch-key";

export interface FeatureSwitch {
  readonly maintainer: string;
  readonly enabled: boolean;
  readonly enabledUserHashes?: readonly string[];
}

async function sha1(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
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
  [FeatureSwitchKey.DeelConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.DocuSignConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.DropboxConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.FigmaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.GmailConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.GoogleSheetsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.GoogleDocsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.GoogleDriveConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.StravaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
};

/**
 * Check if a feature is enabled for the given user.
 *
 * When `userId` is provided and the switch has `enabledUserHashes`,
 * the userId is SHA-1 hashed and compared against the stored hashes.
 */
export async function isFeatureEnabled(
  key: FeatureSwitchKey,
  userId?: string,
): Promise<boolean> {
  const featureSwitch = FEATURE_SWITCHES[key];
  if (featureSwitch.enabled) {
    return true;
  }
  if (userId && featureSwitch.enabledUserHashes?.length) {
    const hash = await sha1(userId);
    return featureSwitch.enabledUserHashes.includes(hash);
  }
  return false;
}
