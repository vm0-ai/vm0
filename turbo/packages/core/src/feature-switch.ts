/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as FNV-1a hashes to avoid exposing plain-text identifiers in source code.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Every registered switch accepts user overrides
 * through `POST /api/feature-switches`. For money-granting, credential, or
 * privilege-escalation endpoints, gate with a hard identity check (e.g.
 * `isStaffOrg()` from `./staff-org`) instead of this system.
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

export interface FeatureSwitchMetadata {
  readonly maintainer: string;
  readonly description?: string;
  readonly rolloutStage: FeatureSwitchRolloutStage;
}

export type FeatureSwitchRolloutStage =
  | "released"
  | "beta"
  | "alpha"
  | "internal";

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
  [FeatureSwitchKey.BillConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the BILL Spend & Expense connector",
    enabled: false,
  },
  [FeatureSwitchKey.BentomlConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the BentoML model serving connector",
    enabled: false,
  },
  [FeatureSwitchKey.CanvaConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Canva design connector",
    enabled: false,
  },
  [FeatureSwitchKey.CalComConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Cal.com scheduling connector",
    enabled: false,
  },
  [FeatureSwitchKey.CopperConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Copper CRM connector",
    enabled: false,
  },
  [FeatureSwitchKey.DatadogConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Datadog observability connector",
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
  [FeatureSwitchKey.ExpensifyConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Expensify accounting connector",
    enabled: false,
  },
  [FeatureSwitchKey.MercuryConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Mercury banking connector",
    enabled: false,
  },
  [FeatureSwitchKey.NeonConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Neon serverless Postgres connector",
    enabled: false,
  },
  [FeatureSwitchKey.NetSuiteConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Oracle NetSuite ERP connector",
    enabled: false,
  },
  [FeatureSwitchKey.GarminConnectConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Garmin Connect wellness connector",
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
  [FeatureSwitchKey.PosthogConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the PostHog analytics connector",
    enabled: false,
  },
  [FeatureSwitchKey.PayPalConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the PayPal payments connector",
    enabled: false,
  },
  [FeatureSwitchKey.RampConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Ramp spend management connector",
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
  [FeatureSwitchKey.SpotifyConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Spotify connector integration",
    enabled: false,
  },
  [FeatureSwitchKey.StripeMarketplaceOAuthConnector]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Show Stripe Marketplace OAuth as a sign-in option for the Stripe connector.",
    enabled: false,
  },
  [FeatureSwitchKey.OkouDebug]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Reveal activity debug surfaces, activity log navigation, appended system prompts, realtime connection diagnostics, and Debug preferences",
    enabled: false,
  },
  [FeatureSwitchKey.Banking]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Enable the managed banking gateway and banking:read OKOU_TOKEN capability for Finicity-backed accounts, balances, and transactions.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.Lab]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the Lab page for viewing feature rollout stages",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.NotionWorkflowAutomations]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable Notion event workflow automations, starting with child pages created under a configured parent page.",
    enabled: true,
  },
  [FeatureSwitchKey.GoogleFormsWorkflowAutomations]: {
    maintainer: "lancy@vm0.ai",
    description: "Enable Google Forms response workflow automations.",
    enabled: true,
  },
  [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable Stripe invoice-paid workflow automations with immutable Live-mode OAuth bindings.",
    enabled: false,
  },
  [FeatureSwitchKey.OfficialWorkflows]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable Official Workflow catalog discovery and new installations.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MorningBrief]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable the first-class Morning Brief experience in Preferences.",
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
  [FeatureSwitchKey.WorkdayConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Workday HCM and finance connector",
    enabled: false,
  },

  [FeatureSwitchKey.CodexFastMode]: {
    maintainer: "lancy@vm0.ai",
    description: "Enable Codex fast mode for GPT 5.6 runs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.NewChatDefaultModelAction]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Make changing the personal default model an explicit action in the new-chat model picker.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CloudBrowserPreference]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Let members choose whether Cloud browser is enabled by default in new chats.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.RealAgentInPreview]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Send preview chat runs through real agent CLIs instead of preview mock runners.",
    enabled: false,
  },
  [FeatureSwitchKey.PiLoop]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Run web chat jobs with the sandbox-owned official Pi runtime, JSONL session persistence, and shared Codex-compatible memory.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PresentationScreenshot]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Enable local presentation rendering to ordered page screenshots.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PresentationTemplates]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Enable owner-scoped presentation template imports and catalog APIs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.IntroVideo]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Show the prompt, file, HeyGen style, avatar, and voice intro-video flow in new chat.",
    enabled: false,
    enabledEmailHashes: ["9fd4ee92"], // fnv1a("bingjie@vm0.ai")
  },
  [FeatureSwitchKey.AvatarComposerV2]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Use the background-free avatar composer for new agents and avatar customization.",
    enabled: true,
  },
  [FeatureSwitchKey.AvatarNeckSweater]: {
    maintainer: "ming@vm0.ai",
    description:
      "Give composer avatars a shared neck and sweater, scaling each head so every chin meets the same collar.",
    enabled: false,
    // Staff first: this redraws every avatar that already exists, not just
    // newly created ones, so the whole population changes the moment it widens.
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatTranslation]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Translate selected assistant text into a remembered target language.",
    enabled: false,
  },
  [FeatureSwitchKey.VoiceInputV2]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Transcribe and polish voice input before inserting it into the composer, with Mod+Shift+E to start or stop recording.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZapierConnector]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Enable the Zapier connector. When disabled, Zapier is hidden from the connectors list and cannot be connected.",
    enabled: false,
  },
  [FeatureSwitchKey.ComputerUseDesktopPlugins]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable Zero Desktop Computer Use plugins for local resources, starting with the bundled filesystem plugin gateway.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatErrorRecovery]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Replace supported Codex and Claude Code limit errors with recovery actions in chat.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatRunWorkFolding]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show live elapsed work status and fold prior assistant output during active and completed chat runs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ProgressiveArtifactPreview]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Publish coherent website and HTML presentation previews while the agent continues improving them.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatThinkingSpinner]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Replace the three-block chat thinking loader with a rotating Okou mark.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerImageAnnotation]: {
    maintainer: "tongx@vm0.ai",
    description:
      "Let an attached image be marked up in the composer lightbox — boxes, arrows, freehand, text, highlight and redaction, each able to carry a note — and send a rendered copy carrying the editable marks.",
    enabled: false,
    // Scoped to the maintainer rather than the whole staff org while the
    // render-on-confirm upload is still unexercised outside tests.
    enabledEmailHashes: ["56bef1aa"], // fnv1a("tongx@vm0.ai")
  },
  [FeatureSwitchKey.FollowUpOptimize]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Use a concise, language-matched prompt for recommended chat follow-ups.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ResponsiveFollowupCards]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Render recommended follow-ups as an equal-height centered card rail in narrow chat layouts.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.StableChatThreadNavigation]: {
    maintainer: "ethan@okou.ai",
    description:
      "Keep pinned chats in a stable, manually adjustable order, show current chats in empty search, and use numbered shortcuts inside the search dialog.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.GradientColorThemes]: {
    maintainer: "ming@vm0.ai",
    description:
      "Apply a palette-derived tint across interface surfaces, borders, states, and workspace ambience.",
    enabled: false,
    // Ming only for the first pass; widen once the system mapping settles.
    enabledEmailHashes: ["54757055"], // fnv1a("ming@vm0.ai")
  },
  [FeatureSwitchKey.GeistTypeface]: {
    maintainer: "ming@vm0.ai",
    description:
      "Set the interface typeface to Geist and Geist Mono instead of Noto Sans and JetBrains Mono.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SharedThreadSharing]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Create immutable public snapshots from explicitly selected chat messages.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SidebarSubscriptionUsage]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show Codex and Claude Code personal subscription usage in the sidebar footer.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.PersonalModelProviderAccounts]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Allow personal Codex and Claude Code subscriptions to store and manually switch between multiple accounts.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.FeishuIntegration]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show the Feishu direct-message integration and Works page entry point.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CustomConnectorMcp]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable remote Streamable HTTP MCP definitions for organization Custom Connectors.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SshAccess]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable standalone Runner-mediated SSH configuration",
    enabled: false,
  },
  [FeatureSwitchKey.NewUi]: {
    maintainer: "ming@vm0.ai",
    description:
      "Lay the workspace out as a card floating on the shell's grey, with the two sidebars on the site's own greys and a brand-hued composer focus ring in dark.",
    enabled: false,
    // Ming only while the shell settles; widen once the layout is signed off.
    enabledEmailHashes: ["54757055"], // fnv1a("ming@vm0.ai")
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
 * Return defaults enabled by the supplied email identity alone.
 *
 * The API feature-switch response cannot evaluate email allowlists because its
 * auth context contains only user and organization IDs. Platform reapplies
 * these defaults after the server's effective map, before stored overrides.
 */
export function getEmailEnabledFeatureStates(
  email?: string,
): Partial<Record<FeatureSwitchKey, true>> {
  const result: Partial<Record<FeatureSwitchKey, true>> = {};
  if (!email) {
    return result;
  }

  const emailHash = fnv1a(email.toLowerCase());
  for (const key of Object.values(FeatureSwitchKey)) {
    if (FEATURE_SWITCHES[key].enabledEmailHashes?.includes(emailHash)) {
      result[key] = true;
    }
  }
  return result;
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

function getFeatureSwitchRolloutStage(
  key: FeatureSwitchKey,
  featureSwitch: FeatureSwitch,
): FeatureSwitchRolloutStage {
  if (key.startsWith("_")) {
    return "internal";
  }
  if (featureSwitch.enabled) {
    return "released";
  }
  if (
    featureSwitch.enabledOrgIdHashes?.some((hash) => {
      return STAFF_ORG_ID_HASHES.includes(hash);
    })
  ) {
    return "beta";
  }
  return "alpha";
}

/**
 * Return display metadata for every feature switch.
 */
export function getFeatureSwitchMetadata(): Record<
  FeatureSwitchKey,
  FeatureSwitchMetadata
> {
  const result = {} as Record<FeatureSwitchKey, FeatureSwitchMetadata>;
  for (const key of Object.values(FeatureSwitchKey)) {
    const featureSwitch = FEATURE_SWITCHES[key];
    result[key] = {
      maintainer: featureSwitch.maintainer,
      description: featureSwitch.description,
      rolloutStage: getFeatureSwitchRolloutStage(key, featureSwitch),
    };
  }
  return result;
}

/** Keep overrides for currently registered feature switches. */
export function filterFeatureSwitchOverrides(
  switches: Record<string, boolean>,
): Record<string, boolean> {
  const filtered: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(switches)) {
    if (key in FEATURE_SWITCHES) {
      filtered[key] = value;
    }
  }
  return filtered;
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
