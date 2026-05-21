import { z } from "zod";
import { FeatureSwitchKey } from "./feature-switch-key";
import { github } from "./connectors/github";
import { gmail } from "./connectors/gmail";
import { notion } from "./connectors/notion";
import { x } from "./connectors/x";
import { googleDrive } from "./connectors/google-drive";
import { slack } from "./connectors/slack";
import { googleSheets } from "./connectors/google-sheets";
import { googleCalendar } from "./connectors/google-calendar";
import { googleDocs } from "./connectors/google-docs";
import { linear } from "./connectors/linear";
import { intervalsIcu } from "./connectors/intervals-icu";
import { vercel } from "./connectors/vercel";
import { strava } from "./connectors/strava";
import { googleMeet } from "./connectors/google-meet";
import { hubspot } from "./connectors/hubspot";
import { localAgent } from "./connectors/local-agent";
import { sentry } from "./connectors/sentry";
import { todoist } from "./connectors/todoist";
import { xero } from "./connectors/xero";
import { airtable } from "./connectors/airtable";
import { docusign } from "./connectors/docusign";
import { googleAds } from "./connectors/google-ads";
import { googleMaps } from "./connectors/google-maps";
import { gumroad } from "./connectors/gumroad";
import { spotify } from "./connectors/spotify";
import { agentmail } from "./connectors/agentmail";
import { agora } from "./connectors/agora";
import { ahrefs } from "./connectors/ahrefs";
import { altium365 } from "./connectors/altium-365";
import { amplitude } from "./connectors/amplitude";
import { anthropicManagedAgents } from "./connectors/anthropic-managed-agents";
import { apify } from "./connectors/apify";
import { apollo } from "./connectors/apollo";
import { asana } from "./connectors/asana";
import { atlassian } from "./connectors/atlassian";
import { attio } from "./connectors/attio";
import { atlascloud } from "./connectors/atlascloud";
import { aviationstack } from "./connectors/aviationstack";
import { axiom } from "./connectors/axiom";
import { bentoml } from "./connectors/bentoml";
import { bitrix } from "./connectors/bitrix";
import { braveSearch } from "./connectors/brave-search";
import { brex } from "./connectors/brex";
import { brevo } from "./connectors/brevo";
import { brightData } from "./connectors/bright-data";
import { browserbase } from "./connectors/browserbase";
import { browserless } from "./connectors/browserless";
import { browserstack } from "./connectors/browserstack";
import { browserUse } from "./connectors/browser-use";
import { buffer } from "./connectors/buffer";
import { builtwith } from "./connectors/builtwith";
import { calCom } from "./connectors/cal-com";
import { calendly } from "./connectors/calendly";
import { canva } from "./connectors/canva";
import { chatwoot } from "./connectors/chatwoot";
import { checkr } from "./connectors/checkr";
import { clado } from "./connectors/clado";
import { clerk } from "./connectors/clerk";
import { clickup } from "./connectors/clickup";
import { close } from "./connectors/close";
import { cloudflare } from "./connectors/cloudflare";
import { cloudinary } from "./connectors/cloudinary";
import { coda } from "./connectors/coda";
import { computer } from "./connectors/computer";
import { cronlytic } from "./connectors/cronlytic";
import { customerIo } from "./connectors/customer-io";
import { db9 } from "./connectors/db9";
import { deel } from "./connectors/deel";
import { deepseek } from "./connectors/deepseek";
import { devto } from "./connectors/devto";
import { diffbot } from "./connectors/diffbot";
import { dify } from "./connectors/dify";
import { discord } from "./connectors/discord";
import { discordWebhook } from "./connectors/discord-webhook";
import { doppler } from "./connectors/doppler";
import { doubao } from "./connectors/doubao";
import { drive9 } from "./connectors/drive9";
import { dropbox } from "./connectors/dropbox";
import { dropboxSign } from "./connectors/dropbox-sign";
import { duffel } from "./connectors/duffel";
import { e2b } from "./connectors/e2b";
import { elevenlabs } from "./connectors/elevenlabs";
import { etsy } from "./connectors/etsy";
import { exa } from "./connectors/exa";
import { explorium } from "./connectors/explorium";
import { faire } from "./connectors/faire";
import { fal } from "./connectors/fal";
import { figma } from "./connectors/figma";
import { firecrawl } from "./connectors/firecrawl";
import { fireflies } from "./connectors/fireflies";
import { freshdesk } from "./connectors/freshdesk";
import { gamma } from "./connectors/gamma";
import { garminConnect } from "./connectors/garmin-connect";
import { gemini } from "./connectors/gemini";
import { gitlab } from "./connectors/gitlab";
import { gong } from "./connectors/gong";
import { granola } from "./connectors/granola";
import { greenhouse } from "./connectors/greenhouse";
import { groq } from "./connectors/groq";
import { helicone } from "./connectors/helicone";
import { heygen } from "./connectors/heygen";
import { htmlcsstoimage } from "./connectors/htmlcsstoimage";
import { huggingFace } from "./connectors/hugging-face";
import { hume } from "./connectors/hume";
import { hunter } from "./connectors/hunter";
import { imgur } from "./connectors/imgur";
import { infisical } from "./connectors/infisical";
import { instagram } from "./connectors/instagram";
import { instantly } from "./connectors/instantly";
import { intercom } from "./connectors/intercom";
import { ironclad } from "./connectors/ironclad";
import { jam } from "./connectors/jam";
import { jira } from "./connectors/jira";
import { jotform } from "./connectors/jotform";
import { klaviyo } from "./connectors/klaviyo";
import { kommo } from "./connectors/kommo";
import { langfuse } from "./connectors/langfuse";
import { langsmith } from "./connectors/langsmith";
import { lark } from "./connectors/lark";
import { line } from "./connectors/line";
import { localBrowser } from "./connectors/local-browser";
import { loops } from "./connectors/loops";
import { luma } from "./connectors/luma";
import { lumaAi } from "./connectors/luma-ai";
import { mailchimp } from "./connectors/mailchimp";
import { mailsac } from "./connectors/mailsac";
import { make } from "./connectors/make";
import { manus } from "./connectors/manus";
import { mapbox } from "./connectors/mapbox";
import { mathpix } from "./connectors/mathpix";
import { mem0 } from "./connectors/mem0";
import { mercury } from "./connectors/mercury";
import { metaAds } from "./connectors/meta-ads";
import { metabase } from "./connectors/metabase";
import { minimax } from "./connectors/minimax";
import { minio } from "./connectors/minio";
import { miro } from "./connectors/miro";
import { mixpanel } from "./connectors/mixpanel";
import { monday } from "./connectors/monday";
import { moss } from "./connectors/moss";
import { msg9 } from "./connectors/msg9";
import { n8n } from "./connectors/n8n";
import { neon } from "./connectors/neon";
import { novita } from "./connectors/novita";
import { nyne } from "./connectors/nyne";
import { onyx } from "./connectors/onyx";
import { openai } from "./connectors/openai";
import { openrouter } from "./connectors/openrouter";
import { openweather } from "./connectors/openweather";
import { outlookCalendar } from "./connectors/outlook-calendar";
import { outlookMail } from "./connectors/outlook-mail";
import { pandadoc } from "./connectors/pandadoc";
import { pdf4me } from "./connectors/pdf4me";
import { pdfco } from "./connectors/pdfco";
import { pdforge } from "./connectors/pdforge";
import { perplexity } from "./connectors/perplexity";
import { pika } from "./connectors/pika";
import { pinecone } from "./connectors/pinecone";
import { pipedrive } from "./connectors/pipedrive";
import { plain } from "./connectors/plain";
import { plausible } from "./connectors/plausible";
import { podchaser } from "./connectors/podchaser";
import { posthog } from "./connectors/posthog";
import { prismaPostgres } from "./connectors/prisma-postgres";
import { productlane } from "./connectors/productlane";
import { pushinator } from "./connectors/pushinator";
import { qdrant } from "./connectors/qdrant";
import { qiita } from "./connectors/qiita";
import { railway } from "./connectors/railway";
import { railwayProject } from "./connectors/railway-project";
import { reap } from "./connectors/reap";
import { reddit } from "./connectors/reddit";
import { reducto } from "./connectors/reducto";
import { replicate } from "./connectors/replicate";
import { reportei } from "./connectors/reportei";
import { resend } from "./connectors/resend";
import { revenuecat } from "./connectors/revenuecat";
import { runway } from "./connectors/runway";
import { salesforce } from "./connectors/salesforce";
import { scrapeninja } from "./connectors/scrapeninja";
import { segment } from "./connectors/segment";
import { sendgrid } from "./connectors/sendgrid";
import { serpapi } from "./connectors/serpapi";
import { servicenow } from "./connectors/servicenow";
import { shopify } from "./connectors/shopify";
import { shortio } from "./connectors/shortio";
import { similarweb } from "./connectors/similarweb";
import { slackWebhook } from "./connectors/slack-webhook";
import { snowflake } from "./connectors/snowflake";
import { sponge } from "./connectors/sponge";
import { sproutgigs } from "./connectors/sproutgigs";
import { square } from "./connectors/square";
import { stabilityAi } from "./connectors/stability-ai";
import { strapi } from "./connectors/strapi";
import { streak } from "./connectors/streak";
import { stripe } from "./connectors/stripe";
import { supabase } from "./connectors/supabase";
import { supadata } from "./connectors/supadata";
import { supermemory } from "./connectors/supermemory";
import { tavily } from "./connectors/tavily";
import { testOauth } from "./connectors/test-oauth";
import { testOauthDevice } from "./connectors/test-oauth-device";
import { testrail } from "./connectors/testrail";
import { tldv } from "./connectors/tldv";
import { together } from "./connectors/together";
import { twenty } from "./connectors/twenty";
import { twilio } from "./connectors/twilio";
import { typeform } from "./connectors/typeform";
import { v0 } from "./connectors/v0";
import { wandb } from "./connectors/wandb";
import { webflow } from "./connectors/webflow";
import { weread } from "./connectors/weread";
import { wix } from "./connectors/wix";
import { workos } from "./connectors/workos";
import { wrike } from "./connectors/wrike";
import { youtube } from "./connectors/youtube";
import { zapier } from "./connectors/zapier";
import { zapsign } from "./connectors/zapsign";
import { zendesk } from "./connectors/zendesk";
import { zep } from "./connectors/zep";
import { zeptomail } from "./connectors/zeptomail";
import { zoom } from "./connectors/zoom";

/**
 * Secret field configuration for connector auth methods
 */
export interface ConnectorSecretConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  /** Storage type: "secret" (default, encrypted) or "variable" (plain text). */
  type?: "secret" | "variable";
}

/**
 * Auth method configuration for user-selectable connector connection flows.
 */
export interface ConnectorAuthMethodConfig {
  label: string;
  helpText?: string;
  /** When set, this auth method is only available while the feature is enabled. */
  featureFlag?: FeatureSwitchKey;
  /** When false, feature-gated UI surfaces should not add an experimental label. */
  showExperimentalLabel?: boolean;
  secrets: Record<string, ConnectorSecretConfig>;
}

/**
 * OAuth configuration for connectors that support OAuth flow.
 */
export type ConnectorOAuthTokenEndpointAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post";

export type ConnectorOAuthClientConfig =
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly tokenEndpointAuthMethod:
        | "client_secret_basic"
        | "client_secret_post";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly tokenEndpointAuthMethod:
        | "client_secret_basic"
        | "client_secret_post";
      readonly clientId: string;
      readonly clientSecret: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly tokenEndpointAuthMethod: "none";
      readonly clientIdEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly tokenEndpointAuthMethod: "none";
      readonly clientId: string;
    }
  | {
      readonly clientRegistration: "dynamic";
      readonly clientType: "public";
      readonly tokenEndpointAuthMethod: "none";
    };

export type StaticConfidentialConnectorOAuthClientConfig = Extract<
  ConnectorOAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "confidential";
  }
>;

export type StaticPublicConnectorOAuthClientConfig = Extract<
  ConnectorOAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "public";
  }
>;

export type DynamicPublicConnectorOAuthClientConfig = Extract<
  ConnectorOAuthClientConfig,
  {
    readonly clientRegistration: "dynamic";
    readonly clientType: "public";
  }
>;

export type ConnectorOAuthFlow = "authorization-code" | "device-authorization";

export interface ConnectorOAuthAuthorizationCodeConfig {
  readonly flow: "authorization-code";
  readonly tokenUrl: string;
  readonly client: ConnectorOAuthClientConfig;
  readonly scopes: string[];
}

export interface ConnectorOAuthDeviceAuthorizationConfig {
  readonly flow: "device-authorization";
  readonly deviceAuthorizationUrl: string;
  readonly tokenUrl: string;
  readonly client: StaticPublicConnectorOAuthClientConfig;
  readonly scopes: string[];
}

export type ConnectorOAuthConfig =
  | ConnectorOAuthAuthorizationCodeConfig
  | ConnectorOAuthDeviceAuthorizationConfig;

/**
 * CLI auth configuration for connectors that can import credentials through a
 * provider CLI.
 */
export type ConnectorCliAuthFlow = "browser-verification";

export interface ConnectorCliAuthConfig {
  /**
   * Frontend flow used to guide the user through the provider CLI login.
   * Provider-specific API calls are adapted separately; this only describes
   * the reusable user interaction pattern.
   */
  flow: ConnectorCliAuthFlow;
  modes?: readonly {
    value: string;
    label: string;
    description?: string;
  }[];
}

/**
 * Connector auth method variants exposed as configured connection flows.
 *
 * These values describe the choices users can select when connecting a
 * service. They are not necessarily the same as the persisted connected
 * credential shape returned by connector APIs.
 *
 * - `oauth` — full OAuth 2.0 flow. Enablement stored as a DB row in
 *   `connectors` (with scopes, external identity, token refresh metadata).
 * - `api-token` — user supplies an API token via the UI. No DB row:
 *   enablement is derived from the presence of required secrets/variables.
 * - `api` — service-managed connection flow for integrations established
 *   outside OAuth or user-entered API-token forms.
 * - `cli-auth` — user imports credentials through a provider CLI. The imported
 *   result may still be stored as another credential shape such as `api-token`.
 */
export type ConnectorAuthMethodType =
  | "oauth"
  | "api-token"
  | "api"
  | "cli-auth";

export const CONNECTOR_AUTH_METHOD_TYPES = [
  "oauth",
  "api-token",
  "api",
  "cli-auth",
] as const satisfies readonly ConnectorAuthMethodType[];

type MissingConnectorAuthMethodType = Exclude<
  ConnectorAuthMethodType,
  (typeof CONNECTOR_AUTH_METHOD_TYPES)[number]
>;

type AssertNever<T extends never> = T;
export type ConnectorAuthMethodTypesCoverUnion =
  AssertNever<MissingConnectorAuthMethodType>;

export type ConnectorDisplayCategory =
  | "ai-general-models"
  | "ai-image-video"
  | "ai-voice-audio"
  | "ai-agent-apps"
  | "ai-memory-tracing-eval"
  | "communication-collaboration"
  | "meetings-scheduling"
  | "docs-files-knowledge"
  | "engineering-team-execution"
  | "sales-crm-business-operations"
  | "marketing-content-growth"
  | "data-automation-infrastructure";

export type ConnectorDisplayCategoryGroup = "ai";

export type ConnectorGenerationType =
  | "audio"
  | "code"
  | "document"
  | "image"
  | "presentation"
  | "text"
  | "video"
  | "website";

export const CONNECTOR_DISPLAY_CATEGORY_GROUPS: Record<
  ConnectorDisplayCategoryGroup,
  { label: string; menuLabel: string }
> = {
  ai: { label: "AI", menuLabel: "AI" },
};

export const CONNECTOR_DISPLAY_CATEGORY_META: Record<
  ConnectorDisplayCategory,
  { label: string; menuLabel: string; group?: ConnectorDisplayCategoryGroup }
> = {
  "ai-general-models": {
    label: "General Models and Reasoning",
    menuLabel: "General Models",
    group: "ai",
  },
  "ai-image-video": {
    label: "Image / Video Generation",
    menuLabel: "Image and Video",
    group: "ai",
  },
  "ai-voice-audio": {
    label: "Voice / Audio",
    menuLabel: "Voice and Audio",
    group: "ai",
  },
  "ai-agent-apps": {
    label: "Agent Platforms and AI Apps",
    menuLabel: "Agent Platforms",
    group: "ai",
  },
  "ai-memory-tracing-eval": {
    label: "Memory / Tracing / Evaluation",
    menuLabel: "Memory and Evaluation",
    group: "ai",
  },
  "communication-collaboration": {
    label: "Communication and Collaboration",
    menuLabel: "Communication",
  },
  "meetings-scheduling": {
    label: "Meetings and Scheduling",
    menuLabel: "Meetings",
  },
  "docs-files-knowledge": {
    label: "Docs, Files, and Knowledge",
    menuLabel: "Documents",
  },
  "engineering-team-execution": {
    label: "Engineering and Team Execution",
    menuLabel: "Engineering",
  },
  "sales-crm-business-operations": {
    label: "Sales, CRM, and Business Operations",
    menuLabel: "Sales and Business",
  },
  "marketing-content-growth": {
    label: "Marketing, Content, and Growth",
    menuLabel: "Marketing",
  },
  "data-automation-infrastructure": {
    label: "Data, Automation, and Infrastructure",
    menuLabel: "Data and Automation",
  },
};

export const CONNECTOR_DISPLAY_CATEGORY_ORDER: readonly ConnectorDisplayCategory[] =
  [
    "ai-general-models",
    "ai-image-video",
    "ai-voice-audio",
    "ai-agent-apps",
    "ai-memory-tracing-eval",
    "communication-collaboration",
    "meetings-scheduling",
    "docs-files-knowledge",
    "engineering-team-execution",
    "sales-crm-business-operations",
    "marketing-content-growth",
    "data-automation-infrastructure",
  ];

type ConnectorAuthMethodsBase = Partial<
  Record<Exclude<ConnectorAuthMethodType, "oauth">, ConnectorAuthMethodConfig>
>;

type ConnectorAuthMethodsWithOAuth = ConnectorAuthMethodsBase & {
  readonly oauth: ConnectorAuthMethodConfig;
};

type ConnectorAuthMethodsWithoutOAuth = ConnectorAuthMethodsBase & {
  readonly oauth?: never;
};

type ConnectorConfigBase = {
  readonly label: string;
  readonly helpText: string;
  readonly category: ConnectorDisplayCategory;
  readonly defaultAuthMethod?: ConnectorAuthMethodType;
  readonly cliAuth?: ConnectorCliAuthConfig;
  /** Environment mapping declaring which env vars this connector provides. */
  readonly environmentMapping: Record<string, string>;
  /**
   * Output categories this connector skill can generate. This is product
   * metadata for discovery and routing, not a permission/capability grant.
   */
  readonly generation?: readonly ConnectorGenerationType[];
  /**
   * Optional concept words and common-guess aliases used by connector search.
   * Lowercase only. Avoid duplicating content already in `label`,
   * `environmentMapping` keys, or `authMethods[*].secrets` keys.
   */
  readonly tags?: readonly string[];
};

/**
 * Base configuration shape for all connector types.
 */
export type ConnectorConfig =
  | (ConnectorConfigBase & {
      readonly authMethods: ConnectorAuthMethodsWithOAuth;
      readonly oauth: ConnectorOAuthConfig;
    })
  | (ConnectorConfigBase & {
      readonly authMethods: ConnectorAuthMethodsWithoutOAuth;
      readonly oauth?: never;
    });

/**
 * Connector type configuration
 * Maps type to display info, auth methods, and OAuth environment mapping.
 *
 * Each connector's definition lives in its own file under ./connectors/.
 * Spreading here keeps the ConnectorType union literal-keyed so the
 * schema, utility getters, and autocomplete all continue to work.
 */
const CONNECTOR_TYPES_DEF = {
  ...github,
  ...gmail,
  ...notion,
  ...x,
  ...googleDrive,
  ...slack,
  ...googleSheets,
  ...googleCalendar,
  ...googleDocs,
  ...linear,
  ...intervalsIcu,
  ...vercel,
  ...strava,
  ...googleMeet,
  ...hubspot,
  ...localAgent,
  ...sentry,
  ...todoist,
  ...xero,
  ...airtable,
  ...docusign,
  ...googleAds,
  ...googleMaps,
  ...gumroad,
  ...spotify,
  ...agentmail,
  ...agora,
  ...ahrefs,
  ...altium365,
  ...amplitude,
  ...anthropicManagedAgents,
  ...apify,
  ...apollo,
  ...asana,
  ...atlassian,
  ...attio,
  ...atlascloud,
  ...aviationstack,
  ...axiom,
  ...bentoml,
  ...bitrix,
  ...braveSearch,
  ...brex,
  ...brevo,
  ...brightData,
  ...browserbase,
  ...browserless,
  ...browserstack,
  ...browserUse,
  ...buffer,
  ...builtwith,
  ...calCom,
  ...calendly,
  ...canva,
  ...chatwoot,
  ...checkr,
  ...clado,
  ...clerk,
  ...clickup,
  ...close,
  ...cloudflare,
  ...cloudinary,
  ...coda,
  ...computer,
  ...cronlytic,
  ...customerIo,
  ...db9,
  ...deel,
  ...deepseek,
  ...devto,
  ...diffbot,
  ...dify,
  ...discord,
  ...discordWebhook,
  ...doppler,
  ...doubao,
  ...drive9,
  ...dropbox,
  ...dropboxSign,
  ...duffel,
  ...e2b,
  ...elevenlabs,
  ...etsy,
  ...exa,
  ...explorium,
  ...faire,
  ...fal,
  ...figma,
  ...firecrawl,
  ...fireflies,
  ...freshdesk,
  ...gamma,
  ...garminConnect,
  ...gemini,
  ...gitlab,
  ...gong,
  ...granola,
  ...greenhouse,
  ...groq,
  ...helicone,
  ...heygen,
  ...htmlcsstoimage,
  ...huggingFace,
  ...hume,
  ...hunter,
  ...imgur,
  ...infisical,
  ...instagram,
  ...instantly,
  ...intercom,
  ...ironclad,
  ...jam,
  ...jira,
  ...jotform,
  ...klaviyo,
  ...kommo,
  ...langfuse,
  ...langsmith,
  ...lark,
  ...line,
  ...localBrowser,
  ...loops,
  ...luma,
  ...lumaAi,
  ...mailchimp,
  ...mailsac,
  ...make,
  ...manus,
  ...mapbox,
  ...mathpix,
  ...mem0,
  ...mercury,
  ...metaAds,
  ...metabase,
  ...minimax,
  ...minio,
  ...miro,
  ...mixpanel,
  ...monday,
  ...moss,
  ...msg9,
  ...n8n,
  ...neon,
  ...novita,
  ...nyne,
  ...onyx,
  ...openai,
  ...openrouter,
  ...openweather,
  ...outlookCalendar,
  ...outlookMail,
  ...pandadoc,
  ...pdf4me,
  ...pdfco,
  ...pdforge,
  ...perplexity,
  ...pika,
  ...pinecone,
  ...pipedrive,
  ...plain,
  ...plausible,
  ...podchaser,
  ...posthog,
  ...prismaPostgres,
  ...productlane,
  ...pushinator,
  ...qdrant,
  ...qiita,
  ...railway,
  ...railwayProject,
  ...reap,
  ...reddit,
  ...reducto,
  ...replicate,
  ...reportei,
  ...resend,
  ...revenuecat,
  ...runway,
  ...salesforce,
  ...scrapeninja,
  ...segment,
  ...sendgrid,
  ...serpapi,
  ...servicenow,
  ...shopify,
  ...shortio,
  ...similarweb,
  ...slackWebhook,
  ...snowflake,
  ...sponge,
  ...sproutgigs,
  ...square,
  ...stabilityAi,
  ...strapi,
  ...streak,
  ...stripe,
  ...supabase,
  ...supadata,
  ...supermemory,
  ...tavily,
  ...testOauth,
  ...testOauthDevice,
  ...testrail,
  ...tldv,
  ...together,
  ...twenty,
  ...twilio,
  ...typeform,
  ...v0,
  ...wandb,
  ...webflow,
  ...weread,
  ...wix,
  ...workos,
  ...wrike,
  ...youtube,
  ...zapier,
  ...zapsign,
  ...zendesk,
  ...zep,
  ...zeptomail,
  ...zoom,
} as const satisfies Record<string, ConnectorConfig>;

export type ConnectorType = Extract<keyof typeof CONNECTOR_TYPES_DEF, string>;
export type OAuthConnectorType = {
  [Type in ConnectorType]: "oauth" extends keyof (typeof CONNECTOR_TYPES_DEF)[Type]["authMethods"]
    ? Type
    : never;
}[ConnectorType];
export type OAuthAuthorizationCodeConnectorType = {
  [Type in OAuthConnectorType]: (typeof CONNECTOR_TYPES_DEF)[Type]["oauth"]["flow"] extends "authorization-code"
    ? Type
    : never;
}[OAuthConnectorType];
export type OAuthDeviceAuthorizationConnectorType = {
  [Type in OAuthConnectorType]: (typeof CONNECTOR_TYPES_DEF)[Type]["oauth"]["flow"] extends "device-authorization"
    ? Type
    : never;
}[OAuthConnectorType];
export type ConnectorCliAuthConnectorType = {
  [Type in ConnectorType]: "cli-auth" extends keyof (typeof CONNECTOR_TYPES_DEF)[Type]["authMethods"]
    ? Type
    : never;
}[ConnectorType];
export type ConnectorBrowserVerificationCliAuthConnectorType = {
  [Type in ConnectorCliAuthConnectorType]: (typeof CONNECTOR_TYPES_DEF)[Type] extends {
    readonly cliAuth: { readonly flow: "browser-verification" };
  }
    ? Type
    : never;
}[ConnectorCliAuthConnectorType];

export const CONNECTOR_TYPES = CONNECTOR_TYPES_DEF;
export const CONNECTOR_TYPE_KEYS = Object.freeze(
  Object.keys(CONNECTOR_TYPES_DEF),
) as readonly [ConnectorType, ...ConnectorType[]];
export const connectorTypeSchema = z.enum(CONNECTOR_TYPE_KEYS);
