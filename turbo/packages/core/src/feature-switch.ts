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
  [FeatureSwitchKey.MetaAdsConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Meta Ads Manager connector",
    enabled: true,
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
    description: "Show the Lab page for toggling experimental features",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.AuthV2AddAccount]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Use the custom Auth v2 sign-in flow when adding another account.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.NotionWorkflowAutomations]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Enable Notion event workflow automations, starting with child pages created under a configured parent page.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.GoogleFormsWorkflowAutomations]: {
    maintainer: "lancy@vm0.ai",
    description: "Enable Google Forms response workflow automations.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
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
  [FeatureSwitchKey.RealAgentInPreview]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Send preview chat runs through real agent CLIs instead of preview mock runners.",
    enabled: false,
  },
  [FeatureSwitchKey.PiLoop]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Run web chat jobs with the sandbox-owned official Pi runtime and JSONL session persistence.",
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
      "Show the guided intro video upload, screen recording, avatar, and voice workflow in new chat.",
    enabled: false,
    enabledEmailHashes: ["9fd4ee92"], // fnv1a("bingjie@vm0.ai")
  },
  [FeatureSwitchKey.ChatConversationLocator]: {
    maintainer: "tongx@vm0.ai",
    description:
      "Show the conversation locator rail beside long chat threads, with hover preview and click-to-jump.",
    enabled: false,
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
  [FeatureSwitchKey.BuiltInModelProviderFallback]: {
    maintainer: "liangyou@vm0.ai",
    description: "Select healthy fallback routes for built-in platform models.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SharedChatDatabase]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Share canonical ChatEvent and ChatThreadEvent synchronization across same-revision browser tabs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerImageAnnotation]: {
    maintainer: "tongx@vm0.ai",
    description:
      "Let an attached image be marked up in the composer lightbox — boxes, arrows, freehand, text, highlight and redaction, each able to carry a note — and send a flattened copy alongside the untouched original.",
    enabled: false,
    // Scoped to the maintainer rather than the whole staff org while the
    // flatten and two-file send are still unexercised outside tests.
    enabledEmailHashes: ["56bef1aa"], // fnv1a("tongx@vm0.ai")
  },
  [FeatureSwitchKey.ChatForward]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show the Forward action in the assistant text-selection pill.",
    enabled: true,
  },
  [FeatureSwitchKey.EmojiPickerCategoryRail]: {
    maintainer: "tongx@vm0.ai",
    description:
      "Add a category icon rail, pinned section titles, jump-to-category scrolling, and a hovered-emoji name bar to the thread emoji picker.",
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
  [FeatureSwitchKey.GradientColorThemes]: {
    maintainer: "ming@vm0.ai",
    description:
      "Apply a palette-derived tint across interface surfaces, borders, states, and workspace ambience.",
    enabled: false,
    // Ming only for the first pass; widen once the system mapping settles.
    enabledEmailHashes: ["54757055"], // fnv1a("ming@vm0.ai")
  },
  [FeatureSwitchKey.ConnectorCatalogCount]: {
    maintainer: "ethan@vm0.ai",
    description: "Show the exact effective connector catalog size.",
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
  [FeatureSwitchKey.ConnectorAccounts]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable multiple credential accounts per built-in or custom connector.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ConcurrencyMemberUsage]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show active concurrency slot usage grouped by workspace member in the queue drawer.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.TeamsIntegration]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show standalone Microsoft Teams integration settings, connect flows, and Works page entry points.",
    enabled: true,
  },
  [FeatureSwitchKey.FeishuIntegration]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show the Feishu direct-message integration and Works page entry point.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.StrapiIntegration]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable Strapi integration settings and Strapi entry-published workflow automations.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.WorkflowConnectorReadiness]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Show the manual connector readiness check on workflow settings pages.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CustomConnectorMcp]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable remote Streamable HTTP MCP definitions for organization Custom Connectors.",
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
