import { z } from "zod";
import { FeatureSwitchKey } from "./feature-switch-key";
import { github } from "./connectors/github";
import { gmail } from "./connectors/gmail";
import { notion } from "./connectors/notion";
import { x } from "./connectors/x";
import { googleDrive } from "./connectors/google-drive";
import { slack } from "./connectors/slack";
import { slock } from "./connectors/slock";
import { googleSheets } from "./connectors/google-sheets";
import { googleCalendar } from "./connectors/google-calendar";
import { googleDocs } from "./connectors/google-docs";
import { linear } from "./connectors/linear";
import { intervalsIcu } from "./connectors/intervals-icu";
import { vercel } from "./connectors/vercel";
import { strava } from "./connectors/strava";
import { googleMeet } from "./connectors/google-meet";
import { hubspot } from "./connectors/hubspot";
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
import { adzuna } from "./connectors/adzuna";
import { altium365 } from "./connectors/altium-365";
import { alchemy } from "./connectors/alchemy";
import { amplitude } from "./connectors/amplitude";
import { amadeus } from "./connectors/amadeus";
import { anthropicManagedAgents } from "./connectors/anthropic-managed-agents";
import { apify } from "./connectors/apify";
import { apollo } from "./connectors/apollo";
import { asana } from "./connectors/asana";
import { atlassian } from "./connectors/atlassian";
import { attio } from "./connectors/attio";
import { atlascloud } from "./connectors/atlascloud";
import { aviationstack } from "./connectors/aviationstack";
import { axiom } from "./connectors/axiom";
import { base44 } from "./connectors/base44";
import { bentoml } from "./connectors/bentoml";
import { bfl } from "./connectors/bfl";
import { bitrefill } from "./connectors/bitrefill";
import { bitrix } from "./connectors/bitrix";
import { bland } from "./connectors/bland";
import { braveSearch } from "./connectors/brave-search";
import { brex } from "./connectors/brex";
import { brevo } from "./connectors/brevo";
import { brightData } from "./connectors/bright-data";
import { browserbase } from "./connectors/browserbase";
import { browserless } from "./connectors/browserless";
import { browserstack } from "./connectors/browserstack";
import { browserUse } from "./connectors/browser-use";
import { bubblemaps } from "./connectors/bubblemaps";
import { buffer } from "./connectors/buffer";
import { builtwith } from "./connectors/builtwith";
import { calCom } from "./connectors/cal-com";
import { calendly } from "./connectors/calendly";
import { canva } from "./connectors/canva";
import { chatwoot } from "./connectors/chatwoot";
import { checkr } from "./connectors/checkr";
import { clado } from "./connectors/clado";
import { clerk } from "./connectors/clerk";
import { clearbit } from "./connectors/clearbit";
import { clickup } from "./connectors/clickup";
import { close } from "./connectors/close";
import { cloudflare } from "./connectors/cloudflare";
import { cloudinary } from "./connectors/cloudinary";
import { coda } from "./connectors/coda";
import { coingecko } from "./connectors/coingecko";
import { coresignal } from "./connectors/coresignal";
import { cronlytic } from "./connectors/cronlytic";
import { crustdata } from "./connectors/crustdata";
import { customerIo } from "./connectors/customer-io";
import { db9 } from "./connectors/db9";
import { deel } from "./connectors/deel";
import { defillama } from "./connectors/defillama";
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
import { etherscan } from "./connectors/etherscan";
import { exa } from "./connectors/exa";
import { explorium } from "./connectors/explorium";
import { faire } from "./connectors/faire";
import { fal } from "./connectors/fal";
import { figma } from "./connectors/figma";
import { firecrawl } from "./connectors/firecrawl";
import { fireflies } from "./connectors/fireflies";
import { flightaware } from "./connectors/flightaware";
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
import { hitem3d } from "./connectors/hitem3d";
import { htmlcsstoimage } from "./connectors/htmlcsstoimage";
import { honcho } from "./connectors/honcho";
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
import { meshy } from "./connectors/meshy";
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
import { parallel } from "./connectors/parallel";
import { pdf4me } from "./connectors/pdf4me";
import { pdfco } from "./connectors/pdfco";
import { pdforge } from "./connectors/pdforge";
import { peopleDataLabs } from "./connectors/people-data-labs";
import { perplexity } from "./connectors/perplexity";
import { pika } from "./connectors/pika";
import { pinecone } from "./connectors/pinecone";
import { pipedream } from "./connectors/pipedream";
import { pipedrive } from "./connectors/pipedrive";
import { plain } from "./connectors/plain";
import { plausible } from "./connectors/plausible";
import { podchaser } from "./connectors/podchaser";
import { posthog } from "./connectors/posthog";
import { porkbun } from "./connectors/porkbun";
import { printful } from "./connectors/printful";
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
import { recraft } from "./connectors/recraft";
import { replicate } from "./connectors/replicate";
import { reportei } from "./connectors/reportei";
import { resend } from "./connectors/resend";
import { rentcast } from "./connectors/rentcast";
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
import { sociavault } from "./connectors/sociavault";
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
import { ticketmaster } from "./connectors/ticketmaster";
import { tldv } from "./connectors/tldv";
import { together } from "./connectors/together";
import { tripo } from "./connectors/tripo";
import { twenty } from "./connectors/twenty";
import { twilio } from "./connectors/twilio";
import { typeform } from "./connectors/typeform";
import { v0 } from "./connectors/v0";
import { wandb } from "./connectors/wandb";
import { webflow } from "./connectors/webflow";
import { weread } from "./connectors/weread";
import { whaleAlert } from "./connectors/whale-alert";
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
 * User-entered field configuration for manual connector grant methods.
 */
export interface ConnectorManualGrantFieldConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  /** Storage type: "secret" (default, encrypted) or "variable" (plain text). */
  storage?: "secret" | "variable";
}

export type ConnectorAuthClientConfig =
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientId: string;
      readonly clientSecret: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly clientIdEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly clientId: string;
    }
  | {
      readonly clientRegistration: "dynamic";
      readonly clientType: "public";
    };

export type StaticConfidentialConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "confidential";
  }
>;

export type StaticPublicConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "public";
  }
>;

export type DynamicPublicConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "dynamic";
    readonly clientType: "public";
  }
>;

export type PublicConnectorAuthClientConfig =
  | StaticPublicConnectorAuthClientConfig
  | DynamicPublicConnectorAuthClientConfig;

export type ConnectorGrantKind =
  | "manual"
  | "auth-code"
  | "device-auth"
  | "managed";

export interface ConnectorManualGrantConfig {
  readonly kind: "manual";
  readonly fields: Record<string, ConnectorManualGrantFieldConfig>;
}

export interface ConnectorAuthCodeGrantConfig {
  readonly kind: "auth-code";
  readonly tokenUrl: string;
  readonly scopes: string[];
}

export interface ConnectorDeviceAuthGrantConfig {
  readonly kind: "device-auth";
  readonly deviceAuthUrl: string;
  readonly tokenUrl: string;
  readonly scopes: string[];
}

export interface ConnectorManagedGrantConfig {
  readonly kind: "managed";
}

export type ConnectorGrantConfig =
  | ConnectorManualGrantConfig
  | ConnectorAuthCodeGrantConfig
  | ConnectorDeviceAuthGrantConfig
  | ConnectorManagedGrantConfig;

export type ConnectorAccessKind = "static" | "refresh-token" | "none";

export type ConnectorEnvBindings = Record<string, string>;

export const CONNECTOR_PLATFORM_SECRET_NAMES = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
] as const;
export type ConnectorPlatformSecretName =
  (typeof CONNECTOR_PLATFORM_SECRET_NAMES)[number];

export interface ConnectorStorageConfig {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
  /** Role mapping for provider-written or refreshable connector secrets. */
  readonly secretRoles?: ConnectorSecretRolesConfig;
}

export interface ConnectorSecretRolesConfig {
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

interface ConnectorEnvBindingAccessConfigBase {
  readonly envBindings: ConnectorEnvBindings;
  /**
   * `$secrets.NAME` backing sources read from platform env instead of connector
   * DB storage. Runtime aliases must still be declared in `envBindings`.
   */
  readonly platformSecrets?: readonly ConnectorPlatformSecretName[];
}

export interface ConnectorStaticAccessConfig extends ConnectorEnvBindingAccessConfigBase {
  readonly kind: "static";
}

export interface ConnectorRefreshTokenAccessConfig extends ConnectorEnvBindingAccessConfigBase {
  readonly kind: "refresh-token";
  readonly tokenUrl: string;
}

export interface ConnectorNoAccessConfig {
  readonly kind: "none";
}

export type ConnectorAccessConfig =
  | ConnectorStaticAccessConfig
  | ConnectorRefreshTokenAccessConfig
  | ConnectorNoAccessConfig;

export type ConnectorRevokeKind = "none" | "token-revoke";

export type ConnectorRevokeConfig =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "token-revoke";
    };

interface ConnectorAuthMethodConfigBase {
  label: string;
  helpText?: string;
  /** When set, this auth method is only available while the feature is enabled. */
  featureFlag?: FeatureSwitchKey;
  /** When false, feature-gated UI surfaces should not add an experimental label. */
  showExperimentalLabel?: boolean;
  /**
   * Connector-scoped storage names owned by this auth method.
   *
   * These lists are write/delete allowlists, not guarantees that rows currently
   * exist in the DB.
   */
  storage: ConnectorStorageConfig;
}

/**
 * Auth method configuration for user-selectable connector connection flows.
 */
export type ConnectorAuthMethodConfig =
  | (ConnectorAuthMethodConfigBase & {
      readonly client: ConnectorAuthClientConfig;
      readonly grant: ConnectorAuthCodeGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodConfigBase & {
      readonly client: PublicConnectorAuthClientConfig;
      readonly grant: ConnectorDeviceAuthGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodConfigBase & {
      readonly client?: ConnectorAuthClientConfig;
      readonly grant: ConnectorManualGrantConfig | ConnectorManagedGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    });

/**
 * Connector auth method ids exposed as configured connection flows.
 *
 * These values are connector registry keys, not lifecycle categories. Behavior
 * must be derived from the selected auth method lifecycle config.
 */
export const CONNECTOR_AUTH_METHOD_IDS = ["oauth", "api-token", "api"] as const;
export const connectorAuthMethodIdSchema = z.enum(CONNECTOR_AUTH_METHOD_IDS);
export type ConnectorAuthMethodId = z.infer<typeof connectorAuthMethodIdSchema>;

type AssertNever<T extends never> = T;

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

type ConnectorAuthMethods = Partial<
  Record<ConnectorAuthMethodId, ConnectorAuthMethodConfig>
>;

type ConnectorConfigBase = {
  readonly label: string;
  readonly helpText: string;
  readonly category: ConnectorDisplayCategory;
  readonly defaultAuthMethod?: ConnectorAuthMethodId;
  /**
   * Output categories this connector skill can generate. This is product
   * metadata for discovery and routing, not a permission/capability grant.
   */
  readonly generation?: readonly ConnectorGenerationType[];
  /**
   * Optional concept words and common-guess aliases used by connector search.
   * Lowercase only. Avoid duplicating content already in `label`,
   * runtime output keys, or auth method field keys.
   */
  readonly tags?: readonly string[];
};

/**
 * Base configuration shape for all connector types.
 */
export type ConnectorConfig = ConnectorConfigBase & {
  readonly authMethods: ConnectorAuthMethods;
};

type ConnectorStorageSecretName<Storage> = Storage extends {
  readonly secrets: readonly (infer Name)[];
}
  ? Extract<Name, string>
  : never;

type ConnectorStorageVariableName<Storage> = Storage extends {
  readonly variables: readonly (infer Name)[];
}
  ? Extract<Name, string>
  : never;

type ConnectorAccessPlatformSecretName<Access> = Access extends {
  readonly platformSecrets: readonly (infer Name)[];
}
  ? Extract<Name, ConnectorPlatformSecretName>
  : never;

type ConnectorRuntimeValueRef<Storage, Access> =
  | `$secrets.${ConnectorStorageSecretName<Storage> | ConnectorAccessPlatformSecretName<Access>}`
  | `$vars.${ConnectorStorageVariableName<Storage>}`;

type ValidatedConnectorEnvBindings<EnvBindings, Storage, Access> = {
  readonly [EnvName in keyof EnvBindings]: EnvBindings[EnvName] extends ConnectorRuntimeValueRef<
    Storage,
    Access
  >
    ? EnvBindings[EnvName]
    : ConnectorRuntimeValueRef<Storage, Access>;
};

type ValidatedConnectorAccessConfig<Access, Storage> = Access extends {
  readonly envBindings: infer EnvBindings;
}
  ? Access & {
      readonly envBindings: ValidatedConnectorEnvBindings<
        EnvBindings,
        Storage,
        Access
      >;
    }
  : Access;

type ValidatedConnectorManualGrantField<
  Field,
  FieldName extends string,
  Storage,
> =
  FieldName extends ConnectorStorageSecretName<Storage>
    ? Field extends { readonly storage: "variable" }
      ? never
      : Field
    : FieldName extends ConnectorStorageVariableName<Storage>
      ? Field extends { readonly storage: "variable" }
        ? Field
        : never
      : never;

type ValidatedConnectorGrantConfig<Grant, Storage> = Grant extends {
  readonly kind: "manual";
  readonly fields: infer Fields;
}
  ? Grant & {
      readonly fields: {
        readonly [FieldName in keyof Fields]: FieldName extends string
          ? ValidatedConnectorManualGrantField<
              Fields[FieldName],
              FieldName,
              Storage
            >
          : never;
      };
    }
  : Grant;

type ValidatedConnectorSecretName<Name, Storage> =
  Name extends ConnectorStorageSecretName<Storage>
    ? Name
    : ConnectorStorageSecretName<Storage>;

type ValidatedConnectorSecretRoles<Bindings, Storage> = Bindings & {
  readonly accessToken?: Bindings extends {
    readonly accessToken: infer Name;
  }
    ? ValidatedConnectorSecretName<Name, Storage>
    : ConnectorStorageSecretName<Storage>;
  readonly refreshToken?: Bindings extends {
    readonly refreshToken: infer Name;
  }
    ? ValidatedConnectorSecretName<Name, Storage>
    : ConnectorStorageSecretName<Storage>;
};

type ConnectorSecretRolesFromStorage<Storage> = Storage extends {
  readonly secretRoles: infer Bindings;
}
  ? Bindings
  : Record<string, never>;

type ConnectorRefreshSecretRoles<Storage> = ValidatedConnectorSecretRoles<
  ConnectorSecretRolesFromStorage<Storage>,
  Storage
> & {
  readonly accessToken: ConnectorStorageSecretName<Storage>;
  readonly refreshToken: ConnectorStorageSecretName<Storage>;
};

type ConnectorStaticProviderSecretRoles<Storage> =
  ValidatedConnectorSecretRoles<
    ConnectorSecretRolesFromStorage<Storage>,
    Storage
  > & {
    readonly accessToken: ConnectorStorageSecretName<Storage>;
  };

type ValidatedConnectorStorageSecretRolesProperty<Method, Storage> =
  Method extends {
    readonly access: { readonly kind: "refresh-token" };
  }
    ? {
        readonly secretRoles: ConnectorRefreshSecretRoles<Storage>;
      }
    : Method extends {
          readonly grant: { readonly kind: "auth-code" | "device-auth" };
          readonly access: { readonly kind: "static" };
        }
      ? {
          readonly secretRoles: ConnectorStaticProviderSecretRoles<Storage>;
        }
      : Storage extends { readonly secretRoles: infer Bindings }
        ? {
            readonly secretRoles: ValidatedConnectorSecretRoles<
              Bindings,
              Storage
            >;
          }
        : { readonly secretRoles?: ConnectorSecretRolesConfig };

type ValidatedConnectorAuthMethod<Method> = Method extends {
  readonly storage: infer Storage;
  readonly grant: infer Grant;
  readonly access: infer Access;
}
  ? Method & {
      readonly storage: Storage &
        ConnectorStorageConfig &
        ValidatedConnectorStorageSecretRolesProperty<Method, Storage>;
      readonly grant: ValidatedConnectorGrantConfig<Grant, Storage>;
      readonly access: ValidatedConnectorAccessConfig<Access, Storage>;
    }
  : never;

type ValidatedConnectorConfig<Config> = Config extends {
  readonly authMethods: infer AuthMethods;
}
  ? Config & {
      readonly authMethods: {
        readonly [Method in keyof AuthMethods]: ValidatedConnectorAuthMethod<
          AuthMethods[Method]
        >;
      };
    }
  : never;

type ValidatedConnectorRegistry<Configs> = {
  readonly [Type in keyof Configs]: ValidatedConnectorConfig<Configs[Type]>;
};

function defineConnectors<
  const Configs extends Record<string, ConnectorConfig>,
>(configs: Configs & ValidatedConnectorRegistry<Configs>): Configs {
  return configs;
}

/**
 * Connector type configuration
 * Maps type to display info, auth methods, and runtime env bindings.
 *
 * Each connector's definition lives in its own file under ./connectors/.
 * Spreading here keeps the ConnectorType union literal-keyed so the
 * schema, utility getters, and autocomplete all continue to work.
 */
const CONNECTOR_TYPES_DEF = defineConnectors({
  ...github,
  ...gmail,
  ...notion,
  ...x,
  ...googleDrive,
  ...slack,
  ...slock,
  ...googleSheets,
  ...googleCalendar,
  ...googleDocs,
  ...linear,
  ...intervalsIcu,
  ...vercel,
  ...strava,
  ...googleMeet,
  ...hubspot,
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
  ...adzuna,
  ...altium365,
  ...alchemy,
  ...amplitude,
  ...amadeus,
  ...anthropicManagedAgents,
  ...apify,
  ...apollo,
  ...asana,
  ...atlassian,
  ...attio,
  ...atlascloud,
  ...aviationstack,
  ...axiom,
  ...base44,
  ...bentoml,
  ...bfl,
  ...bitrefill,
  ...bitrix,
  ...bland,
  ...braveSearch,
  ...brex,
  ...brevo,
  ...brightData,
  ...browserbase,
  ...browserless,
  ...browserstack,
  ...browserUse,
  ...bubblemaps,
  ...buffer,
  ...builtwith,
  ...calCom,
  ...calendly,
  ...canva,
  ...chatwoot,
  ...checkr,
  ...clado,
  ...clerk,
  ...clearbit,
  ...clickup,
  ...close,
  ...cloudflare,
  ...cloudinary,
  ...coda,
  ...coingecko,
  ...coresignal,
  ...cronlytic,
  ...crustdata,
  ...customerIo,
  ...db9,
  ...deel,
  ...defillama,
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
  ...etherscan,
  ...exa,
  ...explorium,
  ...faire,
  ...fal,
  ...figma,
  ...firecrawl,
  ...fireflies,
  ...flightaware,
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
  ...hitem3d,
  ...htmlcsstoimage,
  ...honcho,
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
  ...meshy,
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
  ...parallel,
  ...pdf4me,
  ...pdfco,
  ...pdforge,
  ...peopleDataLabs,
  ...perplexity,
  ...pika,
  ...pinecone,
  ...pipedream,
  ...pipedrive,
  ...plain,
  ...plausible,
  ...podchaser,
  ...posthog,
  ...porkbun,
  ...printful,
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
  ...recraft,
  ...replicate,
  ...reportei,
  ...resend,
  ...rentcast,
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
  ...sociavault,
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
  ...ticketmaster,
  ...tldv,
  ...together,
  ...tripo,
  ...twenty,
  ...twilio,
  ...typeform,
  ...v0,
  ...wandb,
  ...webflow,
  ...weread,
  ...whaleAlert,
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
} as const);

export type ConnectorType = Extract<keyof typeof CONNECTOR_TYPES_DEF, string>;
type ConnectorAuthMethodsOf<Type extends ConnectorType> =
  (typeof CONNECTOR_TYPES_DEF)[Type]["authMethods"];

export type ConnectorAuthMethodIds<Type extends ConnectorType> = Extract<
  keyof ConnectorAuthMethodsOf<Type>,
  ConnectorAuthMethodId
>;
export type ConnectorAuthMethodConfigFor<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
> = ConnectorAuthMethodsOf<Type>[Method] & ConnectorAuthMethodConfig;
export type ConnectorAuthMethodClientConfig<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
> = "client" extends keyof ConnectorAuthMethodsOf<Type>[Method]
  ? ConnectorAuthMethodsOf<Type>[Method]["client"] extends ConnectorAuthClientConfig
    ? ConnectorAuthMethodsOf<Type>[Method]["client"]
    : never
  : never;

export type ConnectorAuthMethodIdsByGrantKind<
  Type extends ConnectorType,
  Kind extends ConnectorGrantKind,
> = Type extends ConnectorType
  ? {
      [Method in ConnectorAuthMethodIds<Type>]: ConnectorAuthMethodsOf<Type>[Method] extends {
        readonly grant: { readonly kind: Kind };
      }
        ? Method
        : never;
    }[ConnectorAuthMethodIds<Type>]
  : never;

export type ConnectorAuthMethodIdsByAccessKind<
  Type extends ConnectorType,
  Kind extends ConnectorAccessKind,
> = Type extends ConnectorType
  ? {
      [Method in ConnectorAuthMethodIds<Type>]: ConnectorAuthMethodsOf<Type>[Method] extends {
        readonly access: { readonly kind: Kind };
      }
        ? Method
        : never;
    }[ConnectorAuthMethodIds<Type>]
  : never;

export type ConnectorAuthMethodIdsByRevokeKind<
  Type extends ConnectorType,
  Kind extends ConnectorRevokeKind,
> = Type extends ConnectorType
  ? {
      [Method in ConnectorAuthMethodIds<Type>]: ConnectorAuthMethodsOf<Type>[Method] extends {
        readonly revoke: { readonly kind: Kind };
      }
        ? Method
        : never;
    }[ConnectorAuthMethodIds<Type>]
  : never;

export type ConnectorTypesByGrantKind<Kind extends ConnectorGrantKind> = {
  [Type in ConnectorType]: {
    [Method in keyof ConnectorAuthMethodsOf<Type>]: ConnectorAuthMethodsOf<Type>[Method] extends {
      readonly grant: { readonly kind: Kind };
    }
      ? Type
      : never;
  }[keyof ConnectorAuthMethodsOf<Type>];
}[ConnectorType];

export type ConnectorTypesByAccessKind<Kind extends ConnectorAccessKind> = {
  [Type in ConnectorType]: {
    [Method in keyof ConnectorAuthMethodsOf<Type>]: ConnectorAuthMethodsOf<Type>[Method] extends {
      readonly access: { readonly kind: Kind };
    }
      ? Type
      : never;
  }[keyof ConnectorAuthMethodsOf<Type>];
}[ConnectorType];

export type ConnectorTypesByRevokeKind<Kind extends ConnectorRevokeKind> = {
  [Type in ConnectorType]: {
    [Method in keyof ConnectorAuthMethodsOf<Type>]: ConnectorAuthMethodsOf<Type>[Method] extends {
      readonly revoke: { readonly kind: Kind };
    }
      ? Type
      : never;
  }[keyof ConnectorAuthMethodsOf<Type>];
}[ConnectorType];

export type ConnectorAuthProviderType = ConnectorTypesByGrantKind<
  "auth-code" | "device-auth"
>;
export type AuthCodeGrantConnectorType = ConnectorTypesByGrantKind<"auth-code">;
export type DeviceAuthGrantConnectorType =
  ConnectorTypesByGrantKind<"device-auth">;
export type ConnectorAuthCodeGrantAuthMethodId<
  Type extends AuthCodeGrantConnectorType = AuthCodeGrantConnectorType,
> = ConnectorAuthMethodIdsByGrantKind<Type, "auth-code">;
export type ConnectorDeviceAuthGrantAuthMethodId<
  Type extends DeviceAuthGrantConnectorType = DeviceAuthGrantConnectorType,
> = ConnectorAuthMethodIdsByGrantKind<Type, "device-auth">;
export type RefreshTokenAccessConnectorType =
  ConnectorTypesByAccessKind<"refresh-token">;
export type TokenRevokeConnectorType =
  ConnectorTypesByRevokeKind<"token-revoke">;
type TokenRevokeConnectorTypeWithNonConfidentialClient = {
  [Type in TokenRevokeConnectorType]: {
    [Method in ConnectorAuthMethodIds<Type>]: ConnectorAuthMethodsOf<Type>[Method] extends {
      readonly revoke: { readonly kind: "token-revoke" };
      readonly client: StaticConfidentialConnectorAuthClientConfig;
    }
      ? never
      : ConnectorAuthMethodsOf<Type>[Method] extends {
            readonly revoke: { readonly kind: "token-revoke" };
          }
        ? Type
        : never;
  }[ConnectorAuthMethodIds<Type>];
}[TokenRevokeConnectorType];
export type TokenRevokeConnectorAuthMethodsUseConfidentialClients =
  AssertNever<TokenRevokeConnectorTypeWithNonConfidentialClient>;

export type ConnectorInvalidDefaultAuthMethodType<
  Configs extends Record<string, ConnectorConfig>,
> = {
  [Type in keyof Configs & string]: Configs[Type] extends {
    readonly defaultAuthMethod: infer DefaultMethod;
  }
    ? DefaultMethod extends Extract<keyof Configs[Type]["authMethods"], string>
      ? never
      : Type
    : never;
}[keyof Configs & string];

export type ConnectorDefaultAuthMethodsMatchConfig = AssertNever<
  ConnectorInvalidDefaultAuthMethodType<typeof CONNECTOR_TYPES_DEF>
>;

export const CONNECTOR_TYPES = CONNECTOR_TYPES_DEF;
export const CONNECTOR_TYPE_KEYS = Object.freeze(
  Object.keys(CONNECTOR_TYPES_DEF),
) as readonly [ConnectorType, ...ConnectorType[]];
export const connectorTypeSchema = z.enum(CONNECTOR_TYPE_KEYS);
