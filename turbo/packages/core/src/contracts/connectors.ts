import { z } from "zod";
import { FeatureSwitchKey } from "../feature-switch-key";
import { axiom } from "./connectors/axiom";
import { ahrefs } from "./connectors/ahrefs";
import { agentmail } from "./connectors/agentmail";
import { agentphone } from "./connectors/agentphone";
import { airtable } from "./connectors/airtable";
import { anthropicManagedAgents } from "./connectors/anthropic-managed-agents";
import { github } from "./connectors/github";
import { notion } from "./connectors/notion";
import { gmail } from "./connectors/gmail";
import { googleSheets } from "./connectors/google-sheets";
import { googleDocs } from "./connectors/google-docs";
import { googleDrive } from "./connectors/google-drive";
import { googleCalendar } from "./connectors/google-calendar";
import { googleMeet } from "./connectors/google-meet";
import { close } from "./connectors/close";
import { huggingFace } from "./connectors/hugging-face";
import { hume } from "./connectors/hume";
import { heygen } from "./connectors/heygen";
import { helicone } from "./connectors/helicone";
import { hubspot } from "./connectors/hubspot";
import { computer } from "./connectors/computer";
import { slack } from "./connectors/slack";
import { docusign } from "./connectors/docusign";
import { duffel } from "./connectors/duffel";
import { dropbox } from "./connectors/dropbox";
import { dropboxSign } from "./connectors/dropbox-sign";
import { linear } from "./connectors/linear";
import { intercom } from "./connectors/intercom";
import { instantly } from "./connectors/instantly";
import { jam } from "./connectors/jam";
import { jira } from "./connectors/jira";
import { jotform } from "./connectors/jotform";
import { klaviyo } from "./connectors/klaviyo";
import { kommo } from "./connectors/kommo";
import { line } from "./connectors/line";
import { loops } from "./connectors/loops";
import { make } from "./connectors/make";
import { mem0 } from "./connectors/mem0";
import { metabase } from "./connectors/metabase";
import { deel } from "./connectors/deel";
import { deepseek } from "./connectors/deepseek";
import { clickup } from "./connectors/clickup";
import { cloudflare } from "./connectors/cloudflare";
import { cloudinary } from "./connectors/cloudinary";
import { cronlytic } from "./connectors/cronlytic";
import { customerIo } from "./connectors/customer-io";
import { dify } from "./connectors/dify";
import { e2b } from "./connectors/e2b";
import { figma } from "./connectors/figma";
import { mercury } from "./connectors/mercury";
import { minimax } from "./connectors/minimax";
import { reportei } from "./connectors/reportei";
import { serpapi } from "./connectors/serpapi";
import { salesforce } from "./connectors/salesforce";
import { reddit } from "./connectors/reddit";
import { strava } from "./connectors/strava";
import { x } from "./connectors/x";
import { neon } from "./connectors/neon";
import { gamma } from "./connectors/gamma";
import { garminConnect } from "./connectors/garmin-connect";
import { vercel } from "./connectors/vercel";
import { sentry } from "./connectors/sentry";
import { posthog } from "./connectors/posthog";
import { productlane } from "./connectors/productlane";
import { intervalsIcu } from "./connectors/intervals-icu";
import { monday } from "./connectors/monday";
import { calendly } from "./connectors/calendly";
import { canva } from "./connectors/canva";
import { calCom } from "./connectors/cal-com";
import { xero } from "./connectors/xero";
import { supabase } from "./connectors/supabase";
import { todoist } from "./connectors/todoist";
import { webflow } from "./connectors/webflow";
import { workos } from "./connectors/workos";
import { wrike } from "./connectors/wrike";
import { outlookMail } from "./connectors/outlook-mail";
import { outlookCalendar } from "./connectors/outlook-calendar";
import { asana } from "./connectors/asana";
import { atlassian } from "./connectors/atlassian";
import { metaAds } from "./connectors/meta-ads";
import { stripe } from "./connectors/stripe";
import { onyx } from "./connectors/onyx";
import { openai } from "./connectors/openai";
import { similarweb } from "./connectors/similarweb";
import { perplexity } from "./connectors/perplexity";
import { pipedrive } from "./connectors/pipedrive";
import { plain } from "./connectors/plain";
import { plausible } from "./connectors/plausible";
import { mailchimp } from "./connectors/mailchimp";
import { chatwoot } from "./connectors/chatwoot";
import { resend } from "./connectors/resend";
import { revenuecat } from "./connectors/revenuecat";
import { replicate } from "./connectors/replicate";
import { pdf4me } from "./connectors/pdf4me";
import { apify } from "./connectors/apify";
import { doppler } from "./connectors/doppler";
import { infisical } from "./connectors/infisical";
import { apollo } from "./connectors/apollo";
import { pinecone } from "./connectors/pinecone";
import { pika } from "./connectors/pika";
import { bitrix } from "./connectors/bitrix";
import { brevo } from "./connectors/brevo";
import { braveSearch } from "./connectors/brave-search";
import { brightData } from "./connectors/bright-data";
import { browserbase } from "./connectors/browserbase";
import { browserUse } from "./connectors/browser-use";
import { browserless } from "./connectors/browserless";
import { fireflies } from "./connectors/fireflies";
import { firecrawl } from "./connectors/firecrawl";
import { scrapeninja } from "./connectors/scrapeninja";
import { pdfco } from "./connectors/pdfco";
import { elevenlabs } from "./connectors/elevenlabs";
import { etsy } from "./connectors/etsy";
import { exa } from "./connectors/exa";
import { explorium } from "./connectors/explorium";
import { devto } from "./connectors/devto";
import { fal } from "./connectors/fal";
import { granola } from "./connectors/granola";
import { podchaser } from "./connectors/podchaser";
import { pushinator } from "./connectors/pushinator";
import { qdrant } from "./connectors/qdrant";
import { qiita } from "./connectors/qiita";
import { zep } from "./connectors/zep";
import { zeptomail } from "./connectors/zeptomail";
import { runway } from "./connectors/runway";
import { shopify } from "./connectors/shopify";
import { shortio } from "./connectors/shortio";
import { stabilityAi } from "./connectors/stability-ai";
import { streak } from "./connectors/streak";
import { strapi } from "./connectors/strapi";
import { supadata } from "./connectors/supadata";
import { tavily } from "./connectors/tavily";
import { tldv } from "./connectors/tldv";
import { together } from "./connectors/together";
import { twenty } from "./connectors/twenty";
import { youtube } from "./connectors/youtube";
import { zapier } from "./connectors/zapier";
import { zapsign } from "./connectors/zapsign";
import { zendesk } from "./connectors/zendesk";
import { htmlcsstoimage } from "./connectors/htmlcsstoimage";
import { imgur } from "./connectors/imgur";
import { instagram } from "./connectors/instagram";
import { prismaPostgres } from "./connectors/prisma-postgres";
import { discord } from "./connectors/discord";
import { lark } from "./connectors/lark";
import { luma } from "./connectors/luma";
import { langsmith } from "./connectors/langsmith";
import { mailsac } from "./connectors/mailsac";
import { manus } from "./connectors/manus";
import { minio } from "./connectors/minio";
import { pdforge } from "./connectors/pdforge";
import { discordWebhook } from "./connectors/discord-webhook";
import { spotify } from "./connectors/spotify";
import { slackWebhook } from "./connectors/slack-webhook";
import { gitlab } from "./connectors/gitlab";
import { wix } from "./connectors/wix";
import { v0 } from "./connectors/v0";
import { db9 } from "./connectors/db9";
import { drive9 } from "./connectors/drive9";
import { msg9 } from "./connectors/msg9";
import { amplitude } from "./connectors/amplitude";
import { attio } from "./connectors/attio";
import { buffer } from "./connectors/buffer";
import { coda } from "./connectors/coda";
import { freshdesk } from "./connectors/freshdesk";
import { miro } from "./connectors/miro";
import { mixpanel } from "./connectors/mixpanel";
import { typeform } from "./connectors/typeform";
import { testOauth } from "./connectors/test-oauth";
import { pandadoc } from "./connectors/pandadoc";
import { greenhouse } from "./connectors/greenhouse";
import { zoom } from "./connectors/zoom";
import { groq } from "./connectors/groq";
import { langfuse } from "./connectors/langfuse";
import { n8n } from "./connectors/n8n";
import { wandb } from "./connectors/wandb";

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
 * Auth method configuration for connectors
 */
export interface ConnectorAuthMethodConfig {
  label: string;
  helpText?: string;
  secrets: Record<string, ConnectorSecretConfig>;
}

/**
 * OAuth configuration for connectors that support OAuth flow.
 */
export interface ConnectorOAuthConfig {
  authorizationUrl?: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * Connector auth method variants.
 *
 * - `oauth` — full OAuth 2.0 flow. Enablement stored as a DB row in
 *   `connectors` (with scopes, external identity, token refresh metadata).
 * - `api-token` — user supplies an API token via the UI. No DB row:
 *   enablement is derived from the presence of required secrets/variables.
 * - `api` — legacy placeholder; no active consumers.
 * - `platform` — platform-supplied credentials. The user does not supply any
 *   secret; they accept terms and the platform injects its own auth at proxy
 *   time. Enablement is a DB row (`authMethod = "platform"`, OAuth columns
 *   NULL) — the connector-layer analog of the `vm0` meta-provider on the
 *   model-provider side.
 */
export type ConnectorAuthMethodType =
  | "oauth"
  | "api-token"
  | "api"
  | "platform";

/**
 * Base configuration shape for all connector types.
 */
export interface ConnectorConfig {
  readonly label: string;
  readonly helpText: string;
  readonly featureFlag?: FeatureSwitchKey;
  /**
   * When true, the featureFlag gates this connector even when it has api-token
   * auth (overrides the default api-token exception).
   */
  readonly strictFeatureFlag?: boolean;
  readonly authMethods: Partial<
    Record<ConnectorAuthMethodType, ConnectorAuthMethodConfig>
  >;
  readonly defaultAuthMethod?: ConnectorAuthMethodType;
  readonly oauth?: ConnectorOAuthConfig;
  /** Environment mapping declaring which env vars this connector provides. */
  readonly environmentMapping: Record<string, string>;
  /**
   * Optional concept words and common-guess aliases used by connector search.
   * Lowercase only. Avoid duplicating content already in `label`,
   * `environmentMapping` keys, or `authMethods[*].secrets` keys.
   */
  readonly tags?: readonly string[];
}

/**
 * Connector type configuration
 * Maps type to display info, auth methods, and OAuth environment mapping.
 *
 * Each connector's definition lives in its own file under ./connectors/.
 * Spreading here keeps the ConnectorType union literal-keyed so the
 * schema, utility getters, and autocomplete all continue to work.
 */
const CONNECTOR_TYPES_DEF = {
  ...axiom,
  ...ahrefs,
  ...agentmail,
  ...agentphone,
  ...airtable,
  ...anthropicManagedAgents,
  ...github,
  ...notion,
  ...gmail,
  ...googleSheets,
  ...googleDocs,
  ...googleDrive,
  ...googleCalendar,
  ...googleMeet,
  ...close,
  ...huggingFace,
  ...hume,
  ...heygen,
  ...helicone,
  ...hubspot,
  ...computer,
  ...slack,
  ...docusign,
  ...duffel,
  ...dropbox,
  ...dropboxSign,
  ...linear,
  ...intercom,
  ...instantly,
  ...jam,
  ...jira,
  ...jotform,
  ...klaviyo,
  ...kommo,
  ...line,
  ...loops,
  ...make,
  ...mem0,
  ...metabase,
  ...deel,
  ...deepseek,
  ...clickup,
  ...cloudflare,
  ...cloudinary,
  ...cronlytic,
  ...customerIo,
  ...dify,
  ...e2b,
  ...figma,
  ...mercury,
  ...minimax,
  ...reportei,
  ...serpapi,
  ...salesforce,
  ...reddit,
  ...strava,
  ...x,
  ...neon,
  ...gamma,
  ...garminConnect,
  ...vercel,
  ...sentry,
  ...posthog,
  ...productlane,
  ...intervalsIcu,
  ...monday,
  ...calendly,
  ...canva,
  ...calCom,
  ...xero,
  ...supabase,
  ...todoist,
  ...webflow,
  ...workos,
  ...wrike,
  ...outlookMail,
  ...outlookCalendar,
  ...asana,
  ...atlassian,
  ...metaAds,
  ...stripe,
  ...onyx,
  ...openai,
  ...similarweb,
  ...perplexity,
  ...pipedrive,
  ...plain,
  ...plausible,
  ...mailchimp,
  ...chatwoot,
  ...resend,
  ...revenuecat,
  ...replicate,
  ...pdf4me,
  ...apify,
  ...doppler,
  ...infisical,
  ...apollo,
  ...pinecone,
  ...pika,
  ...bitrix,
  ...brevo,
  ...braveSearch,
  ...brightData,
  ...browserbase,
  ...browserUse,
  ...browserless,
  ...fireflies,
  ...firecrawl,
  ...scrapeninja,
  ...pdfco,
  ...elevenlabs,
  ...etsy,
  ...exa,
  ...explorium,
  ...devto,
  ...fal,
  ...granola,
  ...podchaser,
  ...pushinator,
  ...qdrant,
  ...qiita,
  ...zep,
  ...zeptomail,
  ...runway,
  ...shopify,
  ...shortio,
  ...stabilityAi,
  ...streak,
  ...strapi,
  ...supadata,
  ...tavily,
  ...tldv,
  ...together,
  ...twenty,
  ...youtube,
  ...zapier,
  ...zapsign,
  ...zendesk,
  ...htmlcsstoimage,
  ...imgur,
  ...instagram,
  ...prismaPostgres,
  ...discord,
  ...lark,
  ...luma,
  ...langsmith,
  ...mailsac,
  ...manus,
  ...minio,
  ...pdforge,
  ...discordWebhook,
  ...spotify,
  ...slackWebhook,
  ...gitlab,
  ...wix,
  ...v0,
  ...db9,
  ...drive9,
  ...msg9,
  ...amplitude,
  ...attio,
  ...buffer,
  ...coda,
  ...freshdesk,
  ...miro,
  ...mixpanel,
  ...typeform,
  ...testOauth,
  ...pandadoc,
  ...greenhouse,
  ...zoom,
  ...groq,
  ...langfuse,
  ...n8n,
  ...wandb,
} as const satisfies Record<string, ConnectorConfig>;

export type ConnectorType = keyof typeof CONNECTOR_TYPES_DEF;

export const CONNECTOR_TYPES: Record<ConnectorType, ConnectorConfig> =
  CONNECTOR_TYPES_DEF;
export const connectorTypeSchema = z.enum(
  Object.keys(CONNECTOR_TYPES_DEF) as [ConnectorType, ...ConnectorType[]],
);
