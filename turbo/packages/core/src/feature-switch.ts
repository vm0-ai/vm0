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
  readonly enabledEmailHashes?: readonly string[];
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

/**
 * Compute the SHA-1 hash of an email address (lowercased).
 * Used for email-based feature switch targeting.
 */
export async function computeEmailHash(email: string): Promise<string> {
  return sha1(email.toLowerCase());
}

const STAFF_USER_HASHES: readonly string[] = [
  "afc25aa601481d794372ed765038148d3a160e2a",
  "1e7de00267c699185653df499f68e8383013ca08",
  "b397fa9b0330b421a5113ac88dd2b01ca2067cfe",
  "d938bb6e49cb8ccfaa962942d69c9ccd1ee239af",
  "67a65740246389d7fecf7702f8b7d6914ad38dc5",
  "55651a8b2c85b35ff0629fa3d4718b9476069d0f",
];

const GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES: readonly string[] = [
  "da04f6515e16a883d6e8c4b03932f51ccc362c10", // Google OAuth reviewer
];

/**
 * Registry of all feature switches
 */
const FEATURE_SWITCHES: Record<FeatureSwitchKey, FeatureSwitch> = {
  [FeatureSwitchKey.Pricing]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.Dummy]: {
    maintainer: "ethan@vm0.ai",
    enabled: true,
  },
  [FeatureSwitchKey.Agents]: {
    maintainer: "ethan@vm0.ai",
    enabled: true,
  },
  [FeatureSwitchKey.Secrets]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.Artifacts]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.ApiKeys]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.AhrefsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.CanvaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
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
    enabledEmailHashes: GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES,
  },
  [FeatureSwitchKey.GoogleSheetsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledEmailHashes: GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES,
  },
  [FeatureSwitchKey.GoogleDocsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledEmailHashes: GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES,
  },
  [FeatureSwitchKey.GoogleDriveConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledEmailHashes: GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES,
  },
  [FeatureSwitchKey.GoogleCalendarConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledEmailHashes: GOOGLE_OAUTH_REVIEWER_EMAIL_HASHES,
  },
  [FeatureSwitchKey.MercuryConnector]: {
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
  [FeatureSwitchKey.SupabaseConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.CloseConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.WebflowConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.OutlookMailConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.OutlookCalendarConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.MetaAdsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.StripeConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.PosthogConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.MailchimpConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.ResendConnector]: {
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
  [FeatureSwitchKey.DataExport]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.ShowSystemPrompt]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
  [FeatureSwitchKey.Usage]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
  },
};

/**
 * Evaluate all feature switches at once for the given user.
 *
 * Computes the user hash once and checks all switches synchronously,
 * avoiding per-key async overhead.
 */
export async function getAllFeatureStates(
  userId?: string,
  email?: string,
): Promise<Record<FeatureSwitchKey, boolean>> {
  const switches = Object.values(FEATURE_SWITCHES);
  const userHash =
    userId && switches.some((s) => s.enabledUserHashes?.length)
      ? await sha1(userId)
      : undefined;
  const emailHash =
    email && switches.some((s) => s.enabledEmailHashes?.length)
      ? await sha1(email.toLowerCase())
      : undefined;

  const result = {} as Record<FeatureSwitchKey, boolean>;
  for (const key of Object.values(FeatureSwitchKey)) {
    const fs = FEATURE_SWITCHES[key];
    if (fs.enabled) {
      result[key] = true;
    } else if (userHash && fs.enabledUserHashes?.includes(userHash)) {
      result[key] = true;
    } else if (emailHash && fs.enabledEmailHashes?.includes(emailHash)) {
      result[key] = true;
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
 * When `email` is provided and the switch has `enabledEmailHashes`,
 * the email is SHA-1 hashed (lowercased) and compared.
 */
export async function isFeatureEnabled(
  key: FeatureSwitchKey,
  userId?: string,
  email?: string,
): Promise<boolean> {
  const featureSwitch = FEATURE_SWITCHES[key];
  if (featureSwitch.enabled) {
    return true;
  }
  if (userId && featureSwitch.enabledUserHashes?.length) {
    const hash = await sha1(userId);
    if (featureSwitch.enabledUserHashes.includes(hash)) return true;
  }
  if (email && featureSwitch.enabledEmailHashes?.length) {
    const hash = await sha1(email.toLowerCase());
    if (featureSwitch.enabledEmailHashes.includes(hash)) return true;
  }
  return false;
}
