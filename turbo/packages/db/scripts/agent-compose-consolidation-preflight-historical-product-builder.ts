import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { agentComposeApiContentSchema } from "@okouai/api-contracts/contracts/composes";
import { computeComposeVersionId } from "../../../apps/api/src/signals/services/agent-compose-content";

/**
 * Aggregate-only migration evidence for #28056 and #28070. Every definition in
 * this file, including the reviewed source fixture, classifier helpers, and
 * review fingerprint, is owned by #26938 Stage 8 removal and must not be
 * imported by product runtime code.
 */
const REVIEW_FINGERPRINT_DOMAIN =
  "vm0:agent-compose-consolidation:historical-product-builder-review:v1";
const REVIEW_AGENT_NAME = "historical-product-builder-review-agent";

const ZERO_VARIABLE_BINDINGS = [
  "ADZUNA_APP_ID",
  "AGORA_APP_ID",
  "ALTIUM365_WORKSPACE_URL",
  "ATLASSIAN_DOMAIN",
  "ATLASSIAN_EMAIL",
  "BROWSERBASE_PROJECT_ID",
  "CLOUDINARY_CLOUD_NAME",
  "CRONLYTIC_USER_ID",
  "FRESHDESK_DOMAIN",
  "GITLAB_HOST",
  "GONG_API_BASE",
  "HCTI_USER_ID",
  "INSTAGRAM_BUSINESS_ACCOUNT_ID",
  "IRONCLAD_HOST",
  "JIRA_DOMAIN",
  "JIRA_EMAIL",
  "KOMMO_SUBDOMAIN",
  "MATHPIX_APP_ID",
  "METABASE_BASE_URL",
  "MINIO_ENDPOINT",
  "MIXPANEL_PROJECT_ID",
  "N8N_BASE_URL",
  "QDRANT_BASE_URL",
  "REAP_API_BASE_URL",
  "SALESFORCE_INSTANCE",
  "SERVICENOW_INSTANCE",
  "SHOPIFY_SHOP",
  "SNOWFLAKE_ACCOUNT",
  "SPROUTGIGS_USER_ID",
  "STRAPI_BASE_URL",
  "TESTRAIL_INSTANCE",
  "ZENDESK_EMAIL",
  "ZENDESK_SUBDOMAIN",
  "ZERO_AGENT_ID",
] as const;

const ZERO_SECRET_BINDINGS = [
  "ADZUNA_APP_KEY",
  "AGENTMAIL_TOKEN",
  "AGORA_APP_CERTIFICATE",
  "AGORA_CUSTOMER_ID",
  "AGORA_CUSTOMER_SECRET",
  "AHREFS_TOKEN",
  "AIRTABLE_TOKEN",
  "ALCHEMY_API_KEY",
  "ALTIUM365_TOKEN",
  "AMADEUS_API_KEY",
  "AMADEUS_API_SECRET",
  "AMPLITUDE_API_KEY",
  "AMPLITUDE_SECRET_KEY",
  "ANTHROPIC_MANAGED_AGENTS_TOKEN",
  "APIFY_TOKEN",
  "APOLLO_TOKEN",
  "ASANA_TOKEN",
  "ATLASCLOUD_API_KEY",
  "ATLASSIAN_TOKEN",
  "ATTIO_TOKEN",
  "AVIATIONSTACK_TOKEN",
  "AXIOM_TOKEN",
  "BFL_API_KEY",
  "BITREFILL_TOKEN",
  "BITRIX_WEBHOOK_URL",
  "BLAND_API_KEY",
  "BRAVE_API_KEY",
  "BREVO_TOKEN",
  "BREX_TOKEN",
  "BRIGHTDATA_TOKEN",
  "BROWSERBASE_TOKEN",
  "BROWSERLESS_TOKEN",
  "BROWSERSTACK_ACCESS_KEY",
  "BROWSERSTACK_USERNAME",
  "BROWSER_USE_TOKEN",
  "BUBBLEMAPS_API_KEY",
  "BUFFER_TOKEN",
  "BUILTWITH_TOKEN",
  "CALCOM_TOKEN",
  "CALENDLY_TOKEN",
  "CHATWOOT_TOKEN",
  "CHECKR_TOKEN",
  "CLADO_TOKEN",
  "CLEARBIT_TOKEN",
  "CLERK_TOKEN",
  "CLICKUP_TOKEN",
  "CLOUDFLARE_TOKEN",
  "CLOUDINARY_API_SECRET",
  "CLOUDINARY_TOKEN",
  "CODA_TOKEN",
  "COINGECKO_TOKEN",
  "CORESIGNAL_TOKEN",
  "CRONLYTIC_API_KEY",
  "CRUSTDATA_TOKEN",
  "CUSTOMERIO_APP_TOKEN",
  "DB9_API_KEY",
  "DEEL_TOKEN",
  "DEEPSEEK_TOKEN",
  "DEFILLAMA_TOKEN",
  "DEVTO_TOKEN",
  "DIFFBOT_TOKEN",
  "DIFY_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_WEBHOOK_URL",
  "DOPPLER_TOKEN",
  "DOUBAO_API_KEY",
  "DRIVE9_TOKEN",
  "DROPBOX_SIGN_TOKEN",
  "DROPBOX_TOKEN",
  "DUFFEL_TOKEN",
  "E2B_TOKEN",
  "ELEVENLABS_TOKEN",
  "ETHERSCAN_API_KEY",
  "ETSY_TOKEN",
  "EXA_TOKEN",
  "EXPLORIUM_TOKEN",
  "FAIRE_TOKEN",
  "FAL_TOKEN",
  "FIGMA_TOKEN",
  "FIRECRAWL_TOKEN",
  "FIREFLIES_TOKEN",
  "FLIGHTAWARE_TOKEN",
  "FRESHDESK_TOKEN",
  "GAMMA_TOKEN",
  "GEMINI_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GMAIL_TOKEN",
  "GONG_ACCESS_KEY",
  "GONG_ACCESS_KEY_SECRET",
  "GOOGLE_CALENDAR_TOKEN",
  "GOOGLE_DOCS_TOKEN",
  "GOOGLE_DRIVE_TOKEN",
  "GOOGLE_MAPS_TOKEN",
  "GOOGLE_MEET_TOKEN",
  "GOOGLE_SHEETS_TOKEN",
  "GRANOLA_TOKEN",
  "GREENHOUSE_TOKEN",
  "GROQ_TOKEN",
  "GUMROAD_TOKEN",
  "HCTI_API_KEY",
  "HELICONE_TOKEN",
  "HEYGEN_TOKEN",
  "HONCHO_API_KEY",
  "HUBSPOT_TOKEN",
  "HUGGING_FACE_TOKEN",
  "HUME_TOKEN",
  "HUNTER_TOKEN",
  "IMGUR_CLIENT_ID",
  "INFISICAL_TOKEN",
  "INSTAGRAM_TOKEN",
  "INSTANTLY_API_KEY",
  "INTERCOM_TOKEN",
  "INTERVALS_ICU_TOKEN",
  "IRONCLAD_API_KEY",
  "JAM_TOKEN",
  "JIRA_API_TOKEN",
  "JOTFORM_TOKEN",
  "KLAVIYO_TOKEN",
  "KOMMO_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGSMITH_TOKEN",
  "LINEAR_TOKEN",
  "LINE_TOKEN",
  "LOOPS_TOKEN",
  "LUMA_API_KEY",
  "LUMA_TOKEN",
  "MAILCHIMP_TOKEN",
  "MAILSAC_TOKEN",
  "MAKE_TOKEN",
  "MANUS_TOKEN",
  "MAPBOX_TOKEN",
  "MATHPIX_APP_KEY",
  "MEM0_TOKEN",
  "MERCURY_TOKEN",
  "MESHY_API_KEY",
  "METABASE_TOKEN",
  "MINIMAX_TOKEN",
  "MINIO_SECRET_TOKEN",
  "MINIO_TOKEN",
  "MIRO_TOKEN",
  "MIXPANEL_SERVICE_ACCOUNT_SECRET",
  "MIXPANEL_SERVICE_ACCOUNT_USERNAME",
  "MONDAY_TOKEN",
  "MOSS_PROJECT_ID",
  "MOSS_PROJECT_KEY",
  "MSG9_TOKEN",
  "N8N_TOKEN",
  "NEON_TOKEN",
  "NOTION_TOKEN",
  "NOVITA_TOKEN",
  "NYNE_API_KEY",
  "NYNE_API_SECRET",
  "ONYX_TOKEN",
  "OPENAI_TOKEN",
  "OPENROUTER_TOKEN",
  "OPENWEATHER_TOKEN",
  "PANDADOC_TOKEN",
  "PARALLEL_API_KEY",
  "PDF4ME_TOKEN",
  "PDFCO_TOKEN",
  "PDFORGE_API_KEY",
  "PEOPLE_DATA_LABS_API_KEY",
  "PERPLEXITY_TOKEN",
  "PIKA_TOKEN",
  "PINECONE_TOKEN",
  "PIPEDREAM_TOKEN",
  "PIPEDRIVE_TOKEN",
  "PLAIN_TOKEN",
  "PLAUSIBLE_TOKEN",
  "PODCHASER_TOKEN",
  "PORKBUN_API_KEY",
  "PORKBUN_SECRET_API_KEY",
  "POSTHOG_TOKEN",
  "PRINTFUL_TOKEN",
  "PRISMA_POSTGRES_TOKEN",
  "PRODUCTLANE_TOKEN",
  "PUSHINATOR_TOKEN",
  "QDRANT_TOKEN",
  "QIITA_TOKEN",
  "RAILWAY_PROJECT_TOKEN",
  "RAILWAY_TOKEN",
  "REAP_API_KEY",
  "RECRAFT_API_TOKEN",
  "REDUCTO_TOKEN",
  "RENTCAST_API_KEY",
  "REPLICATE_TOKEN",
  "REPORTEI_TOKEN",
  "RESEND_TOKEN",
  "REVENUECAT_TOKEN",
  "RUNWAY_TOKEN",
  "SALESFORCE_TOKEN",
  "SCRAPENINJA_TOKEN",
  "SEGMENT_TOKEN",
  "SENDGRID_TOKEN",
  "SENTRY_TOKEN",
  "SERPAPI_TOKEN",
  "SERVICENOW_PASSWORD",
  "SERVICENOW_USERNAME",
  "SHOPIFY_TOKEN",
  "SHORTIO_TOKEN",
  "SIMILARWEB_TOKEN",
  "SLACK_TOKEN",
  "SLACK_WEBHOOK_URL",
  "SNOWFLAKE_PAT",
  "SOCIAVAULT_TOKEN",
  "SPONGE_MASTER_KEY",
  "SPROUTGIGS_API_SECRET",
  "SQUARE_TOKEN",
  "STABILITY_TOKEN",
  "STRAPI_TOKEN",
  "STRAVA_TOKEN",
  "STREAK_TOKEN",
  "STRIPE_TOKEN",
  "SUPABASE_TOKEN",
  "SUPADATA_TOKEN",
  "SUPERMEMORY_API_KEY",
  "TAVILY_TOKEN",
  "TESTRAIL_EMAIL",
  "TESTRAIL_TOKEN",
  "TICKETMASTER_API_KEY",
  "TLDV_TOKEN",
  "TODOIST_TOKEN",
  "TOGETHER_TOKEN",
  "TWENTY_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TYPEFORM_TOKEN",
  "V0_TOKEN",
  "VERCEL_TOKEN",
  "WANDB_TOKEN",
  "WEBFLOW_TOKEN",
  "WEREAD_TOKEN",
  "WHALE_ALERT_API_KEY",
  "WIX_TOKEN",
  "WORKOS_TOKEN",
  "WRIKE_TOKEN",
  "XERO_TOKEN",
  "X_TOKEN",
  "YOUTUBE_TOKEN",
  "ZAPSIGN_TOKEN",
  "ZENDESK_API_TOKEN",
  "ZEPTOMAIL_TOKEN",
  "ZEP_TOKEN",
  "ZERO_TOKEN",
] as const;

interface HistoricalProductBuilderVariant {
  readonly id: string;
  readonly identityBranding: "zero";
  readonly sourceCommit: string;
  readonly sourcePullRequest: number;
  readonly removalCommit: string;
  readonly removalPullRequest: number;
  readonly eligibleConnectorCount: number;
  readonly environmentBindingCount: number;
  readonly variableBindingCount: number;
  readonly secretBindingCount: number;
  readonly reviewFingerprint: string;
}

/**
 * This bounded allowlist is reconstructed from the product-Agent builder and
 * connector catalog at the cited source revision. Production rows cannot add
 * or alter variants. Owned by #26938 Stage 8 removal.
 */
export const HISTORICAL_PRODUCT_BUILDER_VARIANTS = [
  {
    id: "zero-connector-catalog-at-3b45e4e",
    identityBranding: "zero",
    sourceCommit: "3b45e4eab8f1ca26f7187800c6e475b198ec0f28",
    sourcePullRequest: 14_831,
    removalCommit: "68a48441b4c05ccd25d9599dd2b4e7be808aa450",
    removalPullRequest: 14_820,
    eligibleConnectorCount: 229,
    environmentBindingCount: 281,
    variableBindingCount: 34,
    secretBindingCount: 247,
    reviewFingerprint:
      "26b88c167bd412c090e532c3d01a4c7ec03bd59465a60b78e27675f3c55ac959",
  },
] as const satisfies readonly HistoricalProductBuilderVariant[];

type HistoricalProductBuilderVariantId =
  (typeof HISTORICAL_PRODUCT_BUILDER_VARIANTS)[number]["id"];

export interface HistoricalProductBuilderCandidate {
  readonly agentName: string;
  readonly headVersionId: string | null;
  readonly versionId: string | null;
  readonly content: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function historicalEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ZERO_VARIABLE_BINDINGS) {
    environment[name] = "${{ vars." + name + " }}";
  }
  for (const name of ZERO_SECRET_BINDINGS) {
    environment[name] = "${{ secrets." + name + " }}";
  }
  return environment;
}

/** Exact source-reconstructed fixture. Owned by #26938 Stage 8 removal. */
export function buildHistoricalProductBuilderContent(
  variantId: HistoricalProductBuilderVariantId,
  agentName: string,
): Record<string, unknown> {
  switch (variantId) {
    case "zero-connector-catalog-at-3b45e4e": {
      return {
        version: "1",
        agents: {
          [agentName]: {
            framework: "claude-code",
            instructions: "CLAUDE.md",
            environment: historicalEnvironment(),
          },
        },
      };
    }
  }
}

/** Deterministic source-review seal. Owned by #26938 Stage 8 removal. */
export function computeHistoricalProductBuilderReviewFingerprint(
  variant: HistoricalProductBuilderVariant,
): string {
  const contentHash = computeComposeVersionId(
    buildHistoricalProductBuilderContent(
      "zero-connector-catalog-at-3b45e4e",
      REVIEW_AGENT_NAME,
    ),
  );
  const parts = [
    variant.id,
    variant.identityBranding,
    variant.sourceCommit,
    String(variant.sourcePullRequest),
    variant.removalCommit,
    String(variant.removalPullRequest),
    String(variant.eligibleConnectorCount),
    String(variant.environmentBindingCount),
    String(variant.variableBindingCount),
    String(variant.secretBindingCount),
    contentHash,
  ];
  const hash = createHash("sha256");
  hash.update(REVIEW_FINGERPRINT_DOMAIN);
  hash.update("\0");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hasReviewedDefinition(
  variant: HistoricalProductBuilderVariant,
): boolean {
  const allBindings = [...ZERO_VARIABLE_BINDINGS, ...ZERO_SECRET_BINDINGS];
  return (
    ZERO_VARIABLE_BINDINGS.length === variant.variableBindingCount &&
    ZERO_SECRET_BINDINGS.length === variant.secretBindingCount &&
    allBindings.length === variant.environmentBindingCount &&
    new Set(allBindings).size === variant.environmentBindingCount &&
    computeHistoricalProductBuilderReviewFingerprint(variant) ===
      variant.reviewFingerprint
  );
}

/**
 * Pure, fail-closed historical origin classifier. It accepts only a present
 * current head whose entire schema-valid content equals a sealed repository
 * variant after substituting the exact normalized product Agent name.
 * Owned by #26938 Stage 8 removal.
 */
export function isExactHistoricalProductBuilderCandidate(
  row: HistoricalProductBuilderCandidate,
): boolean {
  if (
    row.headVersionId === null ||
    row.versionId === null ||
    row.headVersionId !== row.versionId ||
    row.agentName !== row.agentName.toLowerCase() ||
    !isRecord(row.content) ||
    computeComposeVersionId(row.content) !== row.versionId
  ) {
    return false;
  }

  const parsed = agentComposeApiContentSchema.safeParse(row.content);
  if (!parsed.success || !isDeepStrictEqual(row.content, parsed.data)) {
    return false;
  }
  const agentEntries = Object.entries(parsed.data.agents);
  if (agentEntries.length !== 1) {
    return false;
  }
  const activeAgentName = agentEntries[0]?.[0];
  if (
    activeAgentName === undefined ||
    activeAgentName.toLowerCase() !== row.agentName
  ) {
    return false;
  }

  return HISTORICAL_PRODUCT_BUILDER_VARIANTS.some((variant) => {
    if (!hasReviewedDefinition(variant)) {
      return false;
    }
    const expected = buildHistoricalProductBuilderContent(
      variant.id,
      row.agentName,
    );
    return isDeepStrictEqual(row.content, expected);
  });
}
