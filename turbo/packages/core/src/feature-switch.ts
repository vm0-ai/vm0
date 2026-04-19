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
  [FeatureSwitchKey.Dummy]: {
    maintainer: "ethan@vm0.ai",
    description: "Test-only feature switch for flag system validation",
    enabled: true,
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
    description: "Enable the Figma design connector",
    enabled: false,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Mercury banking connector",
    enabled: false,
  },
  [FeatureSwitchKey.NeonConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Neon serverless Postgres connector",
    enabled: false,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Garmin Connect wellness connector",
    enabled: false,
  },
  [FeatureSwitchKey.RedditConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Reddit connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.SupabaseConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Supabase database connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.CloseConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Close CRM connector",
    enabled: false,
  },
  [FeatureSwitchKey.WebflowConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Webflow site management connector",
    enabled: false,
  },
  [FeatureSwitchKey.OutlookMailConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Outlook Mail connector",
    enabled: false,
  },
  [FeatureSwitchKey.OutlookCalendarConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Outlook Calendar connector",
    enabled: false,
  },
  [FeatureSwitchKey.MetaAdsConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Meta Ads Manager connector",
    enabled: false,
  },
  [FeatureSwitchKey.StripeConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Stripe payment connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.PosthogConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the PostHog analytics connector",
    enabled: false,
  },
  [FeatureSwitchKey.MailchimpConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Mailchimp email marketing connector",
    enabled: false,
  },
  [FeatureSwitchKey.ResendConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Resend email service connector",
    enabled: false,
  },
  [FeatureSwitchKey.SpotifyConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Spotify connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.DataExport]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the data export option in account menu",
    enabled: false,
  },
  [FeatureSwitchKey.ShowSystemPrompt]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the appended system prompt in activity detail steps",
    enabled: false,
  },
  [FeatureSwitchKey.UsageAnalytics]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show admin-only daily credits chart and per-run records on Usage page",
    enabled: false,
  },
  [FeatureSwitchKey.ModelDetail]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the selected model name in activity details",
    enabled: false,
  },
  [FeatureSwitchKey.ActivityLogList]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the Activities list page and breadcrumb navigation",
    enabled: false,
  },
  [FeatureSwitchKey.ZeroDebug]: {
    maintainer: "ethan@vm0.ai",
    description: "Reveal debug tabs in activity pages and Debug preferences",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerUse]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable remote desktop host registration",
    enabled: false,
  },
  [FeatureSwitchKey.Lab]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the Lab page for toggling experimental features",
    enabled: false,
  },
  [FeatureSwitchKey.AuditLink]: {
    maintainer: "ethan@vm0.ai",
    description: "Show audit log links in Slack messages",
    enabled: false,
  },
  [FeatureSwitchKey.PhoneIntegration]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the Phone page for voice call integration",
    enabled: false,
  },
  [FeatureSwitchKey.VoiceChat]: {
    maintainer: "lancy@vm0.ai",
    description: "Enable the Voice Chat feature and API endpoints",
    enabled: false,
  },
  [FeatureSwitchKey.AudioIO]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable audio input/output features in chat (TTS read-aloud, auto-read, voice input)",
    enabled: false,
  },
  [FeatureSwitchKey.MissionControlSidebar]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the Mission Control page entry in the sidebar",
    enabled: false,
  },
  [FeatureSwitchKey.AutoSkill]: {
    maintainer: "lancy@vm0.ai",
    description: "Enable automatic skill creation in agent prompts",
    enabled: false,
  },
  [FeatureSwitchKey.SandboxReuse]: {
    maintainer: "liangyou@vm0.ai",
    description: "Enable sandbox reuse (keep-alive) across conversation turns",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ScheduleRunHistory]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show Run History tab on schedules page and Chat-from-schedule button on activity detail",
    enabled: false,
  },
  [FeatureSwitchKey.TestOauthConnector]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable the test-oauth connector, a synthetic OAuth 2.0 provider used only for automated tests. Off in prod.",
    enabled: false,
  },
  [FeatureSwitchKey.ChatHeaderNewButton]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Replace the Invite people button in the agent chat page header with a New button that creates a new chat thread",
    enabled: false,
  },
  [FeatureSwitchKey.ChatThreadReadIndicator]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show the unread watermark dot and bold title for chat threads with unread messages in the sidebar",
    enabled: false,
  },
  [FeatureSwitchKey.InlineThinkingDot]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show an inline streaming cursor on the last assistant message while the agent run is still active, so users see the agent is still working even after it has produced output",
    enabled: false,
  },
  [FeatureSwitchKey.FreshdeskConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Freshdesk helpdesk connector",
    enabled: false,
  },
  [FeatureSwitchKey.ZoomConnector]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable the Zoom connector (OAuth 2.0) for meetings, past participants, and cloud recordings access",
    enabled: false,
  },
  [FeatureSwitchKey.Vm0KimiModel]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Expose Moonshot Kimi K2.5 as a selectable model under the VM0 managed provider",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Vm0GlmModel]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Expose Z.AI GLM-5.1 as a selectable model under the VM0 managed provider",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Vm0MinimaxModel]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Expose MiniMax M2.7 as a selectable model under the VM0 managed provider",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SlackAgentSwitch]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Per-user agent override in the org-aware Slack app. When enabled for an org, " +
      "members can choose which agent replies to their Slack mentions / DMs via " +
      "`/zero switch` (opens an agent picker modal) or the Switch button on the " +
      "App Home tab. The help text for `/zero help` also lists the switch subcommand. " +
      "Selecting an alternate agent persists a row in `slack_user_agent_preferences` " +
      "so the preference follows the user across every Slack workspace joined under " +
      "the same org, and subsequent mention / DM replies from a non-default agent " +
      "carry a `Sent via <agent>` footer so it's clear which agent produced the reply. " +
      "When gated off, the modal, slash subcommand, App Home button, and help line " +
      "are hidden AND any existing DB preferences are ignored at read time — every " +
      "user falls back to the org default agent with no footer. Staff-only during the " +
      "rollout window defined by `enabledOrgIdHashes`.",
    enabled: false,
  },
  [FeatureSwitchKey.ModelProviderSelection]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show the model provider + model picker on the agent profile page and schedule dialog. " +
      "Allows per-agent and per-schedule model selection, overriding the org default. " +
      "Staff-only during initial rollout.",
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
