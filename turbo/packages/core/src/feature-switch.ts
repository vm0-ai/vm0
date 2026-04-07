/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as FNV-1a hashes to avoid exposing plain-text identifiers in source code.
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

/**
 * FNV-1a 32-bit hash — fast, synchronous, no crypto API needed.
 * Returns an 8-character lowercase hex string.
 */
function fnv1a(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// NOTE: Migrated from SHA-1 to FNV-1a. Original user IDs are not stored in the codebase,
// so hashes could not be auto-migrated. Staff access continues to work via STAFF_ORG_ID_HASHES.
// Each team member can add their own FNV-1a hash by running:
//   node -e "let h=2166136261>>>0; for(const c of '<your-clerk-user-id>') { h^=c.charCodeAt(0); h=Math.imul(h,16777619)>>>0; } console.log(h.toString(16).padStart(8,'0'))"
const STAFF_USER_HASHES: readonly string[] = [];

const STAFF_ORG_ID_HASHES: readonly string[] = [
  "afce210e", // org_3ANttyrbWYJk6JKRSTRLEsbsDLe
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
  [FeatureSwitchKey.ModelDetail]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ActivityLogList]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZeroDebug]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComputerUse]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledUserHashes: STAFF_USER_HASHES,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MobileChatListPage]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
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
 * Computes identity hashes once and checks all switches synchronously.
 */
export function getAllFeatureStates(
  ctx?: FeatureSwitchContext,
): Record<FeatureSwitchKey, boolean> {
  const switches = Object.values(FEATURE_SWITCHES);
  const hashes: ResolvedHashes = {
    userHash:
      ctx?.userId &&
      switches.some((s) => {
        return s.enabledUserHashes?.length;
      })
        ? fnv1a(ctx.userId)
        : undefined,
    emailHash:
      ctx?.email &&
      switches.some((s) => {
        return s.enabledEmailHashes?.length;
      })
        ? fnv1a(ctx.email.toLowerCase())
        : undefined,
    orgIdHash:
      ctx?.orgId &&
      switches.some((s) => {
        return s.enabledOrgIdHashes?.length;
      })
        ? fnv1a(ctx.orgId)
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
 */
export function isFeatureEnabled(
  key: FeatureSwitchKey,
  ctx?: FeatureSwitchContext,
): boolean {
  const featureSwitch = FEATURE_SWITCHES[key];
  if (featureSwitch.enabled) {
    return true;
  }
  if (ctx?.userId && featureSwitch.enabledUserHashes?.length) {
    if (featureSwitch.enabledUserHashes.includes(fnv1a(ctx.userId)))
      return true;
  }
  if (ctx?.email && featureSwitch.enabledEmailHashes?.length) {
    if (
      featureSwitch.enabledEmailHashes.includes(fnv1a(ctx.email.toLowerCase()))
    )
      return true;
  }
  if (ctx?.orgId && featureSwitch.enabledOrgIdHashes?.length) {
    if (featureSwitch.enabledOrgIdHashes.includes(fnv1a(ctx.orgId)))
      return true;
  }
  return false;
}
