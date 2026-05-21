/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as FNV-1a hashes to avoid exposing plain-text identifiers in source code.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Any authenticated user can self-enable any
 * switch via `POST /api/zero/feature-switches` — overrides are read by
 * `isFeatureEnabled` before the registry. For money-granting, credential,
 * or privilege-escalation endpoints, gate with a hard identity check
 * (e.g. `isStaffOrg()` from `./staff-org`) instead of this system.
 */

import { FeatureSwitchKey } from "./feature-switch-key";
import { STAFF_ORG_ID_HASHES, fnv1a } from "./identity-hash";

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
  [FeatureSwitchKey.BentomlConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the BentoML model serving connector",
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
  [FeatureSwitchKey.GoogleAdsConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Google Ads connector",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
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
  [FeatureSwitchKey.CliAuthStripe]: {
    maintainer: "liangyou@vm0.ai",
    description: "Gate Stripe-specific CLI auth UI and API surfaces.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CodexDeviceAuth]: {
    maintainer: "liangyou@vm0.ai",
    description: "Gate Codex device-auth UI and API surfaces.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PosthogConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the PostHog analytics connector",
    enabled: false,
  },
  [FeatureSwitchKey.PwaOfflineCache]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable PWA offline caching (static asset cache-first, offline fallback page, and service worker updateViaCache: none)",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
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
  [FeatureSwitchKey.ZeroDebug]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Reveal activity debug surfaces, activity log navigation, appended system prompts, and Debug preferences",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerUse]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable remote desktop host registration",
    enabled: false,
  },
  [FeatureSwitchKey.LocalBrowserUse]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable the Local Browser connector and user-authorized browser host lifecycle",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.DesktopLocalAgent]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable the Desktop-owned Local Agent page, folder selection, and native host lifecycle",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Lab]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the Lab page for toggling experimental features",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AuditLink]: {
    maintainer: "ethan@vm0.ai",
    description: "Show audit log links in integration replies",
    enabled: false,
  },
  [FeatureSwitchKey.AudioOutput]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable audio output in chat (TTS read-aloud + auto-read) — gates the volume/read buttons and the /api/zero/voice-io/tts route",
    enabled: false,
  },
  [FeatureSwitchKey.AutoSkill]: {
    maintainer: "lancy@vm0.ai",
    description: "Enable automatic skill creation in agent prompts",
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
  [FeatureSwitchKey.ChatMessageStartButton]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show an icon button in assistant message group actions that scrolls back to the start of that message group.",
    enabled: false,
  },
  [FeatureSwitchKey.Goal]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable Codex-style goal mode in web chat: typing `/go <objective>` starts a self-continuing chain that runs up to 10 turns until the agent emits the [GOAL_DONE] sentinel, the budget is exhausted, the run fails, or the user interrupts.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatThreadRename]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Adds a Rename chat item to the sidebar thread kebab menu. When the user renames a thread, automated title generation is suppressed for that thread.",
    enabled: false,
  },
  [FeatureSwitchKey.DocsSite]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Enable the authenticated Strapi-backed docs site routes, navigation entry, and docs pages. Staff-only during rollout; per-user toggle via Lab.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.FreshdeskConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Freshdesk helpdesk connector",
    enabled: false,
  },
  [FeatureSwitchKey.StabilityAiConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Stability AI image generation connector",
    enabled: false,
  },
  [FeatureSwitchKey.ZoomConnector]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable the Zoom connector (OAuth 2.0) for meetings, past participants, and cloud recordings access",
    enabled: false,
  },

  [FeatureSwitchKey.ApiKeys]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Gate the custom /settings/api-keys UI for issuing personal access tokens used by the /api/v1 public surface. When disabled, the settings page redirects to / and the sidebar menu item is hidden. The backend /api/v1 verification does NOT consult this flag — previously issued PATs continue to work.",
    enabled: false,
  },
  [FeatureSwitchKey.ApiBackend]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Route platform API traffic to the api backend host instead of the www backend host. Unported endpoints continue through the api backend's web fallback proxy.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ConnectorCategories]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show category sections and the hover-reveal outline menu on the Connectors settings page. " +
      "Staff-only during rollout.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.StoredSecretKmsRead]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Prefer AWS KMS material when reading stored-secret envelopes. Legacy AES remains as a fallback for old or explicitly legacy-only rows.",
    enabled: true,
  },
  [FeatureSwitchKey.StoredSecretKmsWrite]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Dual-write stored-secret values to AWS KMS in addition to the legacy AES branch. When OFF, writes stay legacy-only even if SECRETS_KMS_KEY_ID is configured. This gates the KMS GenerateDataKey call so a missing IAM grant does not 500 every secret save.",
    enabled: true,
  },
  [FeatureSwitchKey.PersistentSecretKmsRead]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Prefer AWS KMS material when reading persistent secret envelopes such as bot tokens, callback secrets, OAuth tokens, and queued execution secrets. Legacy AES remains as a fallback while backfills complete.",
    enabled: false,
  },
  [FeatureSwitchKey.PersistentSecretKmsWrite]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Dual-write persistent secret values to AWS KMS in addition to the legacy AES branch. When OFF, writes stay legacy-only even if SECRETS_KMS_KEY_ID is configured.",
    enabled: true,
  },
  [FeatureSwitchKey.Trinity]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Embed the voice-chat mic toggle + voice-mode layout into the agent chat page. Gates the mic launcher, composer swap, and status/subtitle/task-card UI.",
    enabled: false,
  },
  [FeatureSwitchKey.ZapierConnector]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable the Zapier connector. When disabled, Zapier is hidden from the connectors list and cannot be connected.",
    enabled: false,
  },
  [FeatureSwitchKey.VoiceChatRealtimeBilling]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Gate voice-chat realtime billing (Plan D, Epic #12128). When OFF, " +
      "the token route mints an OpenAI ephemeral token without admission " +
      "checks and the /session-started, /usage, and /session-ended " +
      "endpoints are 200 no-ops — the org gets unmetered voice-chat. " +
      "When ON, the token route runs credit + pricing admission, " +
      "/session-started inserts an audit row in voice_chat_realtime_" +
      "sessions, and the browser self-reports response.done + " +
      "transcription.completed usage events for billing. Staff-only " +
      "during rollout; operator flips per org via the feature-switch " +
      "overrides API.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.HostedSites]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable static hosted-site deployments from zero host. Staff-only during rollout.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SandboxIoLimiters]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable runner-provided disk and network device rate limiters for sandbox VMs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZeroMaps]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable managed Zero Maps CLI access for geocoding, directions, and places. Staff-only during rollout.",
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
      if (key in FEATURE_SWITCHES && value !== undefined) {
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
 *
 * `ctx` is required so callers must pass identity (userId/orgId/email) or an
 * explicit `{}`. A switch gated by `enabledUserHashes` / `enabledOrgIdHashes`
 * silently returns `false` when ctx omits identity, which has caused bugs.
 * Client-side callers should usually read the platform `featureSwitch$` signal
 * instead — it also merges DB overrides on top of identity context.
 */
export function isFeatureEnabled(
  key: FeatureSwitchKey,
  ctx: FeatureSwitchContext,
): boolean {
  const override = ctx.overrides?.[key];
  if (override !== undefined) {
    return override;
  }

  const featureSwitch = FEATURE_SWITCHES[key];
  if (featureSwitch.enabled) {
    return true;
  }
  if (ctx.userId && featureSwitch.enabledUserHashes?.length) {
    if (featureSwitch.enabledUserHashes.includes(fnv1a(ctx.userId)))
      return true;
  }
  if (ctx.email && featureSwitch.enabledEmailHashes?.length) {
    if (
      featureSwitch.enabledEmailHashes.includes(fnv1a(ctx.email.toLowerCase()))
    )
      return true;
  }
  if (ctx.orgId && featureSwitch.enabledOrgIdHashes?.length) {
    if (featureSwitch.enabledOrgIdHashes.includes(fnv1a(ctx.orgId)))
      return true;
  }
  return false;
}
