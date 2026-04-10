/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as FNV-1a hashes to avoid exposing plain-text identifiers in source code.
 */

import { FeatureSwitchKey } from "./feature-switch-key";

export interface FeatureSwitch {
  readonly maintainer: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly enabledUserHashes?: readonly string[];
  readonly enabledEmailHashes?: readonly string[];
  readonly enabledOrgIdHashes?: readonly string[];
}

export interface FeatureSwitchContext {
  readonly userId?: string;
  readonly email?: string;
  readonly orgId?: string;
  readonly overrides?: Partial<Record<FeatureSwitchKey, boolean>>;
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
    description: "Enable multi-agent orchestration in runs",
    enabled: true,
  },
  [FeatureSwitchKey.Secrets]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.Artifacts]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable artifact storage and management",
    enabled: false,
  },
  [FeatureSwitchKey.ApiKeys]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable platform-managed API key pool",
    enabled: false,
  },
  [FeatureSwitchKey.AhrefsConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Ahrefs SEO connector",
    enabled: false,
  },
  [FeatureSwitchKey.CanvaConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Canva design connector",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Computer connector for local service tunneling",
    enabled: false,
  },
  [FeatureSwitchKey.DeelConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Deel HR connector",
    enabled: false,
  },
  [FeatureSwitchKey.DocuSignConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the DocuSign e-signature connector",
    enabled: false,
  },
  [FeatureSwitchKey.DropboxConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Dropbox file storage connector",
    enabled: false,
  },
  [FeatureSwitchKey.FigmaConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.NeonConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.RedditConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.SupabaseConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.CloseConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Close CRM connector",
    enabled: false,
  },
  [FeatureSwitchKey.WebflowConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.OutlookMailConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.OutlookCalendarConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.MetaAdsConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.StripeConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.PosthogConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.MailchimpConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.ResendConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.SpotifyConnector]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.GitHubIntegration]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.TelegramIntegration]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.DataExport]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the data export option in account menu",
    enabled: false,
  },
  [FeatureSwitchKey.ShowSystemPrompt]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.Usage]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.ConcurrentAddOn]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the concurrent agent add-on purchase option",
    enabled: false,
  },
  [FeatureSwitchKey.CreditAddOn]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the credit add-on purchase option",
    enabled: false,
  },
  [FeatureSwitchKey.ModelDetail]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.ActivityLogList]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.ZeroDebug]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerUse]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable remote desktop host registration",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MobileChatListPage]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
  },
  [FeatureSwitchKey.Lab]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AuditLink]: {
    maintainer: "ethan@vm0.ai",
    description: "Show audit log links in Slack messages",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PhoneIntegration]: {
    maintainer: "ethan@vm0.ai",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.VoiceChat]: {
    maintainer: "lancy@vm0.ai",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AutoSkill]: {
    maintainer: "lancy@vm0.ai",
    description: "Enable automatic skill creation in agent prompts",
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

  if (ctx?.overrides) {
    for (const [key, value] of Object.entries(ctx.overrides)) {
      if (value !== undefined) {
        result[key as FeatureSwitchKey] = value;
      }
    }
  }

  return result;
}

/**
 * Return the description for every feature switch.
 */
export function getFeatureSwitchDescriptions(): Record<
  FeatureSwitchKey,
  string | undefined
> {
  const result = {} as Record<FeatureSwitchKey, string | undefined>;
  for (const key of Object.values(FeatureSwitchKey)) {
    result[key] = FEATURE_SWITCHES[key].description;
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
  const override = ctx?.overrides?.[key];
  if (override !== undefined) {
    return override;
  }

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
