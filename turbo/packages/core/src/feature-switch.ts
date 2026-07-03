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
    maintainer: "yuma@vm0.ai",
    description: "Enable the Ahrefs SEO connector",
    enabled: false,
  },
  [FeatureSwitchKey.BentomlConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the BentoML model serving connector",
    enabled: false,
  },
  [FeatureSwitchKey.BoxConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Box file storage connector",
    enabled: false,
  },
  [FeatureSwitchKey.CanvaConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Canva design connector",
    enabled: false,
  },
  [FeatureSwitchKey.DeelConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Deel HR connector",
    enabled: false,
  },
  [FeatureSwitchKey.DocuSignConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the DocuSign e-signature connector",
    enabled: false,
  },
  [FeatureSwitchKey.DropboxConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Dropbox file storage connector",
    enabled: false,
  },
  [FeatureSwitchKey.FigmaConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Figma design connector",
    enabled: false,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Mercury banking connector",
    enabled: false,
  },
  [FeatureSwitchKey.Microsoft365Connector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Microsoft 365 connector",
    enabled: false,
  },
  [FeatureSwitchKey.NeonConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Neon serverless Postgres connector",
    enabled: false,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Garmin Connect wellness connector",
    enabled: false,
  },
  [FeatureSwitchKey.QuickBooksConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the QuickBooks accounting connector",
    enabled: false,
  },
  [FeatureSwitchKey.RedditConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Reddit connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.SupabaseConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Supabase database connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.CloseConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Close CRM connector",
    enabled: false,
  },
  [FeatureSwitchKey.WebflowConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Webflow site management connector",
    enabled: false,
  },
  [FeatureSwitchKey.OutlookMailConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Outlook Mail connector",
    enabled: false,
  },
  [FeatureSwitchKey.OutlookCalendarConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Outlook Calendar connector",
    enabled: false,
  },
  [FeatureSwitchKey.TikTokAdsConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the TikTok Ads Manager connector",
    enabled: false,
  },
  [FeatureSwitchKey.AwsConnector]: {
    maintainer: "liangyou@vm0.ai",
    description: "Enable the temporary AWS remote login connector",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PosthogConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the PostHog analytics connector",
    enabled: false,
  },
  [FeatureSwitchKey.MailchimpConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Mailchimp email marketing connector",
    enabled: false,
  },
  [FeatureSwitchKey.ResendConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Resend email service connector",
    enabled: false,
  },
  [FeatureSwitchKey.PexelsConnector]: {
    maintainer: "bingjie@vm0.ai",
    description: "Enable the Pexels stock photo and video connector",
    enabled: false,
  },
  [FeatureSwitchKey.SpotifyConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Spotify connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.DataExport]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the data export option in account menu",
    enabled: true,
  },
  [FeatureSwitchKey.ZeroDebug]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Reveal activity debug surfaces, activity log navigation, appended system prompts, and Debug preferences",
    enabled: false,
  },
  [FeatureSwitchKey.Banking]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Enable the managed Zero Banking gateway and banking:read ZERO_TOKEN capability for Finicity-backed accounts, balances, and transactions.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Lab]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the Lab page for toggling experimental features",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.WorkflowAutomation]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable workflow automation surfaces, slash workflow commands, event triggers, automation-to-workflow routing, persistent goals, and workflow-driven ZERO_TOKEN capabilities.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.TestOauthConnector]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable the test-oauth connector, a synthetic OAuth 2.0 provider used only for automated tests. Off in prod.",
    enabled: false,
  },
  [FeatureSwitchKey.FreshdeskConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Freshdesk helpdesk connector",
    enabled: false,
  },
  [FeatureSwitchKey.StabilityAiConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Stability AI image generation connector",
    enabled: false,
  },
  [FeatureSwitchKey.ZoomConnector]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Enable the Zoom connector (OAuth 2.0) for meetings, past participants, and cloud recordings access",
    enabled: false,
  },

  [FeatureSwitchKey.ApiKeys]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Gate the custom /settings/api-keys UI for issuing personal access tokens used by the /api/v1 public surface. When disabled, the settings page redirects to / and the sidebar menu item is hidden. The backend /api/v1 verification does NOT consult this flag — previously issued PATs continue to work.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CodexFrameworkForMinimax]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Expose the experimental MiniMax Codex framework provider route for Responses API compatibility testing.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CodexFastMode]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable Codex fast mode for ChatGPT subscription GPT-5.5 web chat runs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZapierConnector]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Enable the Zapier connector. When disabled, Zapier is hidden from the connectors list and cannot be connected.",
    enabled: false,
  },
  [FeatureSwitchKey.ChatGithubPrTracking]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show GitHub PR tracking in chat thread headers when the current agent is connected to and authorized for GitHub. Individuals opt in via feature-switch overrides.",
    enabled: false,
  },
  [FeatureSwitchKey.ChatThreadEmoji]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show the chat thread emoji icon in chat headers and enable the Shift+F2 emoji picker shortcut for staff orgs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MemoryViewer]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Show the read-only memory viewer page in the Zero sidebar and at /memory, listing the files in the user's memory artifact.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.HtmlArtifactCommentEditing]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Enable the HTML artifact comment-editing workflow for collecting DOM comments and preparing instrumented working-copy edits.",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerUseDesktopPlugins]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable Zero Desktop Computer Use plugins for local resources, starting with the bundled filesystem plugin gateway.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.DesktopX64Download]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Show Intel Mac download links for Zero Computer Use after darwin-x64 release artifacts are available.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PresentationImageUnsplashPreferred]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Prefer Unsplash for presentation image resolution, falling back to Pexels when Unsplash has no result or is unconfigured. When off, presentation images are resolved directly from Pexels.",
    enabled: false,
  },
  [FeatureSwitchKey.AgentUnreadIndicators]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show chat unread indicators in sidebar pinned agent lists and the conversation picker.",
    enabled: false,
  },
  [FeatureSwitchKey.ImageArtifactKeyboardNavigation]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Enable left/right keyboard and button navigation between image artifacts within the same chat message, in both the lightbox modal and the artifact sidebar.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AgentsPageRedesign]: {
    maintainer: "ming@vm0.ai",
    description:
      "New Agents page with Public/Private tabs, a public-slot indicator, a Created by footer on every card, a name-first create dialog with a visibility select, and a private empty state.",
    enabled: false,
  },
  [FeatureSwitchKey.SidebarSubscriptionUsage]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show Codex and Claude Code personal subscription usage in the Zero sidebar footer.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatInitialThinkingIndicator]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show fast generated status text in the web chat thinking indicator.",
    enabled: true,
  },
  [FeatureSwitchKey.ChatThreadEventSourcing]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Render the chat sidebar from local chat thread snapshots plus lifecycle events instead of the paged thread list response.",
    enabled: false,
  },
  [FeatureSwitchKey.TeamsIntegration]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show standalone Microsoft Teams integration settings, connect flows, and Works page entry points.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.BytePlusVoiceInputStt]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Route voice input speech-to-text requests through BytePlus Seed ASR flash mode instead of OpenAI.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ImageEditing]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Enable in-canvas image editing (remove background, enhance) from the image preview and artifact sidebar.",
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
