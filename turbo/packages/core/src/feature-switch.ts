/**
 * Feature switch system
 *
 * Provides centralized feature flag management with user-identity based overrides.
 * User IDs are stored as FNV-1a hashes to avoid exposing plain-text identifiers in source code.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Every registered switch accepts user overrides
 * through `POST /api/zero/feature-switches`. For money-granting, credential, or
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

const CUSTOM_MODEL_GATEWAY_ORG_ID_HASHES = [
  ...STAFF_ORG_ID_HASHES,
  "a6e60503", // geo rollout workspace
] as const;

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
  [FeatureSwitchKey.GoogleContactsConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Google Contacts connector",
    enabled: false,
  },
  [FeatureSwitchKey.GoogleFormsConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the Google Forms connector",
    enabled: false,
  },
  [FeatureSwitchKey.JoggAiConnector]: {
    maintainer: "yuma@vm0.ai",
    description: "Enable the JoggAI video generation connector",
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
  [FeatureSwitchKey.MetaAdsConnector]: {
    maintainer: "ethan@vm0.ai",
    description: "Enable the Meta Ads Manager connector",
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
  [FeatureSwitchKey.MorningBrief]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable the daily 7:00 local-time Morning Brief email built from GitHub, Gmail, and Google Calendar.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ManualMorningBrief]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show a Send now button in Settings that triggers a Morning Brief immediately for testing.",
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
  [FeatureSwitchKey.GithubWebhookAutomations]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show creation entry points for GitHub workflow job, pull request review, deployment status, and issue comment automations.",
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
    description:
      "Enable Codex fast mode for ChatGPT subscription GPT 5.5 and GPT 5.6 web chat runs.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ClaudeSessionPruning]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Prune oversized Claude Code checkpoint histories to the latest native compact generation.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.RealAgentInPreview]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Send preview chat runs through real agent CLIs instead of preview mock runners.",
    enabled: false,
  },
  [FeatureSwitchKey.ComposerUploadPopover]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Use the Upload popover in the chat composer instead of the legacy paperclip attachment button.",
    enabled: false,
  },
  [FeatureSwitchKey.StructuredPromptInlineTemplates]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Enable multiple inline artifact templates in structured chat prompts.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CustomModelGateways]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable admin-defined Anthropic Messages and OpenAI Responses model gateway connections.",
    enabled: false,
    enabledOrgIdHashes: CUSTOM_MODEL_GATEWAY_ORG_ID_HASHES,
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
  [FeatureSwitchKey.ChatThreadUnifiedSearch]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show chat thread title results from the local event-driven thread cache in the command-shift-a conversation picker.",
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
  [FeatureSwitchKey.PwaChatKeyboardGestures]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Keep the PWA chat composer pinned above the software keyboard and support swipe-to-dismiss gestures.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ChatThreadSidebarAutoOpen]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Automatically open the latest sidebar-capable card from a running or successfully completed chat run when the utility sidebar is closed and split view is available.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.MermaidDiagrams]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Render ```mermaid code blocks in assistant markdown as diagrams, and tell the web chat agent that they are rendered.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ArtifactSidebarInlineOpen]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Open an artifact clicked in a chat thread inside the already-open artifact sidebar instead of stacking the page-global lightbox over it.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerSkillSubstringSearch]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Match chat composer slash skill suggestions by any slug substring instead of only prefixes.",
    enabled: true,
  },
  [FeatureSwitchKey.ThreeColumnNav]: {
    maintainer: "ming@vm0.ai",
    description:
      "Slack-style three-column navigation: a labeled icon rail, a pinned-agents and chat-threads list column, and the conversation pane.",
    enabled: false,
    // Ming only for the first pass; widen to staff once it settles.
    enabledEmailHashes: ["54757055"], // fnv1a("ming@vm0.ai")
  },
  [FeatureSwitchKey.SidebarSubscriptionUsage]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Show Codex and Claude Code personal subscription usage in the Zero sidebar footer.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.SlackDmSessionRouting]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Reuse agent/model-scoped sessions for top-level Slack direct messages.",
    enabled: true,
  },
  [FeatureSwitchKey.TeamsIntegration]: {
    maintainer: "linghan@vm0.ai",
    description:
      "Show standalone Microsoft Teams integration settings, connect flows, and Works page entry points.",
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
  [FeatureSwitchKey.StrapiIntegration]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Enable Strapi integration settings and Strapi entry-published workflow automations.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ArtifactKeyV2]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Store new user artifacts under flat, ten-character hashed public keys.",
    enabled: false,
  },
  [FeatureSwitchKey.HostedArtifactVersions]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Create immutable hosted artifact versions behind stable site aliases.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.HtmlResourceIndex]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Use target-specific static indexes for HTML generation resource selection.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.VideoArtifactPosters]: {
    maintainer: "bingjie@vm0.ai",
    description:
      "Generate poster images asynchronously when video artifacts are recorded.",
    enabled: true,
  },
  [FeatureSwitchKey.WorkflowConnectorReadiness]: {
    maintainer: "lancy@vm0.ai",
    description:
      "Show the manual connector readiness check on workflow settings pages.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZeroMailReplyFollowUp]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Enable Zero Mail reply follow-up for staff after all API deployments can read Gmail event configurations with threadId.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZeroBrowser]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable thread-scoped Cloud browser access in chat and the Zero CLI.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZeroChatMessaging]: {
    maintainer: "ethan@vm0.ai",
    description:
      "Advertise zero chat create, send, and cancel in the agent system prompt without gating the CLI commands or API.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ZeroImageRecognition]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Enable managed image recognition for Zero runs whose selected model does not support image input.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.ComposerConnectorPermissions]: {
    maintainer: "ming@vm0.ai",
    description:
      "Show the configure-permissions entry in the chat composer connector popover, opening the agent×connector firewall dialog inline.",
    enabled: false,
  },
  [FeatureSwitchKey.CustomConnectorCliCreate]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Allow Zero CLI agents to create and configure custom connectors directly.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CustomConnectorOAuth2]: {
    maintainer: "liangyou@vm0.ai",
    description:
      "Allow org admins to add OAuth 2.0 authentication to custom connectors.",
    enabled: false,
    enabledOrgIdHashes: STAFF_ORG_ID_HASHES,
  },
  [FeatureSwitchKey.CustomConnectorPermissions]: {
    maintainer: "yuma@vm0.ai",
    description:
      "Allow users to manage agent permission grants for custom connectors.",
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
