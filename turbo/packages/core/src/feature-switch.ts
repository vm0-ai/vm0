/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as SHA-1 hashes to avoid exposing plain-text identifiers in source code.
 */

import { FeatureSwitchKey } from "./feature-switch-key";
import type { ConnectorType } from "./contracts/connectors";

export interface FeatureSwitch {
  readonly maintainer: string;
  readonly enabled: boolean;
  readonly enabledUserHashes?: readonly string[];
}

const sha1Cache = new Map<string, string>();

async function sha1(input: string): Promise<string> {
  const cached = sha1Cache.get(input);
  if (cached) return cached;

  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  sha1Cache.set(input, hex);
  return hex;
}

const STAFF_USER_HASHES: readonly string[] = [
  "afc25aa601481d794372ed765038148d3a160e2a",
  "1e7de00267c699185653df499f68e8383013ca08",
  "b397fa9b0330b421a5113ac88dd2b01ca2067cfe",
  "d938bb6e49cb8ccfaa962942d69c9ccd1ee239af",
  "67a65740246389d7fecf7702f8b7d6914ad38dc5",
  "55651a8b2c85b35ff0629fa3d4718b9476069d0f",
];

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
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.DeelConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.DocuSignConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.DropboxConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.FigmaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.GmailConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.GoogleSheetsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.GoogleDocsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.GoogleDriveConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.GoogleCalendarConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.StravaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.NeonConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },

  [FeatureSwitchKey.RedditConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.IntervalsIcuConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.XeroConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.GitHubIntegration]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.TelegramIntegration]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
};

/**
 * Maps connector types to their feature switch keys.
 * Connectors not listed here are always visible.
 */
export const CONNECTOR_FEATURE_FLAGS: Partial<
  Record<ConnectorType, FeatureSwitchKey>
> = {
  computer: FeatureSwitchKey.ComputerConnector,
  deel: FeatureSwitchKey.DeelConnector,
  docusign: FeatureSwitchKey.DocuSignConnector,
  dropbox: FeatureSwitchKey.DropboxConnector,
  figma: FeatureSwitchKey.FigmaConnector,
  gmail: FeatureSwitchKey.GmailConnector,
  "google-sheets": FeatureSwitchKey.GoogleSheetsConnector,
  "google-docs": FeatureSwitchKey.GoogleDocsConnector,
  "google-drive": FeatureSwitchKey.GoogleDriveConnector,
  "google-calendar": FeatureSwitchKey.GoogleCalendarConnector,
  mercury: FeatureSwitchKey.MercuryConnector,
  neon: FeatureSwitchKey.NeonConnector,
  strava: FeatureSwitchKey.StravaConnector,
  "garmin-connect": FeatureSwitchKey.GarminConnectConnector,

  reddit: FeatureSwitchKey.RedditConnector,
  "intervals-icu": FeatureSwitchKey.IntervalsIcuConnector,
  xero: FeatureSwitchKey.XeroConnector,
};

/**
 * Evaluate all feature switches at once for the given user.
 *
 * Computes the user hash once and checks all switches synchronously,
 * avoiding per-key async overhead.
 */
export async function getAllFeatureStates(
  userId?: string,
): Promise<Record<FeatureSwitchKey, boolean>> {
  const userHash =
    userId &&
    Object.values(FEATURE_SWITCHES).some((s) => s.enabledUserHashes?.length)
      ? await sha1(userId)
      : undefined;

  const result = {} as Record<FeatureSwitchKey, boolean>;
  for (const key of Object.values(FeatureSwitchKey)) {
    const fs = FEATURE_SWITCHES[key];
    if (fs.enabled) {
      result[key] = true;
    } else if (userHash && fs.enabledUserHashes?.length) {
      result[key] = fs.enabledUserHashes.includes(userHash);
    } else {
      result[key] = false;
    }
  }
  return result;
}

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
