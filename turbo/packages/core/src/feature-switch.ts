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
  readonly enabledOrgIdHashes?: readonly string[];
}

export interface FeatureSwitchContext {
  readonly userId?: string;
  readonly email?: string;
  readonly orgId?: string;
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

/**
 * Compute the SHA-1 hash of an organization ID.
 * Used for org-based feature switch targeting.
 * No lowercasing — orgId is case-sensitive.
 */
export async function computeOrgIdHash(orgId: string): Promise<string> {
  return sha1(orgId);
}

const STAFF_USER_HASHES: readonly string[] = [
  "afc25aa601481d794372ed765038148d3a160e2a",
  "1e7de00267c699185653df499f68e8383013ca08",
  "b397fa9b0330b421a5113ac88dd2b01ca2067cfe",
  "d938bb6e49cb8ccfaa962942d69c9ccd1ee239af",
  "67a65740246389d7fecf7702f8b7d6914ad38dc5",
  "55651a8b2c85b35ff0629fa3d4718b9476069d0f",
];

const STAFF_ORG_ID_HASHES: readonly string[] = [
  "65de87977d6d1712cd88d7768209f33f7ed12e0b", // org_3ANttyrbWYJk6JKRSTRLEsbsDLe
];

/**
 * Registry of all feature switches
 */
const FEATURE_SWITCHES: Record<FeatureSwitchKey, FeatureSwitch> = {
  [FeatureSwitchKey.Pricing]: {
    maintainer: "ethan@vm0.ai",
    enabled: true,
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
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CanvaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComputerConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.DeelConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.DocuSignConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.DropboxConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.FigmaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.NeonConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },

  [FeatureSwitchKey.RedditConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SupabaseConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CloseConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.WebflowConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.OutlookMailConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.OutlookCalendarConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MetaAdsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.StripeConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PosthogConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MailchimpConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ResendConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SpotifyConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.GitHubIntegration]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.TelegramIntegration]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.DataExport]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ShowSystemPrompt]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Usage]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ConcurrentAddOn]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.CreditAddOn]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
};

interface ResolvedHashes {
  readonly userHash?: string;
  readonly emailHash?: string;
  readonly orgIdHash?: string;
}

function evaluateSwitch(fs: FeatureSwitch, hashes: ResolvedHashes): boolean {
  if (fs.enabled) return true;
  if (hashes.userHash && fs.enabledUserHashes?.includes(hashes.userHash))
    return true;
  if (hashes.emailHash && fs.enabledEmailHashes?.includes(hashes.emailHash))
    return true;
  if (hashes.orgIdHash && fs.enabledOrgIdHashes?.includes(hashes.orgIdHash))
    return true;
  return false;
}

/**
 * Evaluate all feature switches at once for the given context.
 *
 * Computes identity hashes once and checks all switches synchronously,
 * avoiding per-key async overhead.
 */
export async function getAllFeatureStates(
  ctx?: FeatureSwitchContext,
): Promise<Record<FeatureSwitchKey, boolean>> {
  const switches = Object.values(FEATURE_SWITCHES);
  const hashes: ResolvedHashes = {
    userHash:
      ctx?.userId && switches.some((s) => s.enabledUserHashes?.length)
        ? await sha1(ctx.userId)
        : undefined,
    emailHash:
      ctx?.email && switches.some((s) => s.enabledEmailHashes?.length)
        ? await sha1(ctx.email.toLowerCase())
        : undefined,
    orgIdHash:
      ctx?.orgId && switches.some((s) => s.enabledOrgIdHashes?.length)
        ? await sha1(ctx.orgId)
        : undefined,
  };

  const result = {} as Record<FeatureSwitchKey, boolean>;
  for (const key of Object.values(FeatureSwitchKey)) {
    result[key] = evaluateSwitch(FEATURE_SWITCHES[key], hashes);
  }
  return result;
}

/**
 * Check if a feature is enabled for the given context.
 *
 * When `userId` is provided and the switch has `enabledUserHashes`,
 * the userId is SHA-1 hashed and compared against the stored hashes.
 * When `email` is provided and the switch has `enabledEmailHashes`,
 * the email is SHA-1 hashed (lowercased) and compared.
 * When `orgId` is provided and the switch has `enabledOrgIdHashes`,
 * the orgId is SHA-1 hashed and compared.
 */
export async function isFeatureEnabled(
  key: FeatureSwitchKey,
  ctx?: FeatureSwitchContext,
): Promise<boolean> {
  const featureSwitch = FEATURE_SWITCHES[key];
  if (featureSwitch.enabled) {
    return true;
  }
  if (ctx?.userId && featureSwitch.enabledUserHashes?.length) {
    const hash = await sha1(ctx.userId);
    if (featureSwitch.enabledUserHashes.includes(hash)) return true;
  }
  if (ctx?.email && featureSwitch.enabledEmailHashes?.length) {
    const hash = await sha1(ctx.email.toLowerCase());
    if (featureSwitch.enabledEmailHashes.includes(hash)) return true;
  }
  if (ctx?.orgId && featureSwitch.enabledOrgIdHashes?.length) {
    const hash = await sha1(ctx.orgId);
    if (featureSwitch.enabledOrgIdHashes.includes(hash)) return true;
  }
  return false;
}
