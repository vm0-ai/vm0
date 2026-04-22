/**
 * Builtin firewall configs registry.
 *
 * Generated configs are imported here and exposed as a lookup map.
 * The firewall loader checks this registry before falling back to
 * remote GitHub fetch.
 */

import type {
  FirewallConfig,
  FirewallPolicy,
  FirewallPolicies,
  FirewallPolicyValue,
} from "../contracts/firewalls";
import type { ConnectorType } from "../contracts/connectors";
import { CONNECTOR_TYPES } from "../contracts/connectors";
import {
  gmailDefaultAllowed,
  gmailCategories,
  gmailCategoryOrder,
  gmailFirewall,
} from "./gmail.generated";
import {
  slackDefaultAllowed,
  slackCategories,
  slackCategoryOrder,
  slackFirewall,
} from "./slack.generated";
import {
  vercelCategories,
  vercelCategoryOrder,
  vercelFirewall,
} from "./vercel.generated";
import { getConnectorEnvironmentMapping } from "../contracts/connector-utils";
import { agentmailFirewall } from "./agentmail.generated";
import { agentphoneFirewall } from "./agentphone.generated";
import { amplitudeFirewall } from "./amplitude.generated";
import { anthropicManagedAgentsFirewall } from "./anthropic-managed-agents.generated";
import { ahrefsFirewall } from "./ahrefs.generated";
import { airtableFirewall } from "./airtable.generated";
import { apolloFirewall } from "./apollo.generated";
import { apifyFirewall } from "./apify.generated";
import { pikaFirewall } from "./pika.generated";
import { dopplerFirewall } from "./doppler.generated";
import { infisicalFirewall } from "./infisical.generated";
import { asanaFirewall } from "./asana.generated";
import { attioFirewall } from "./attio.generated";
import { atlassianFirewall } from "./atlassian.generated";
import { axiomFirewall } from "./axiom.generated";
import { bitrixFirewall } from "./bitrix.generated";
import { braveSearchFirewall } from "./brave-search.generated";
import { brevoFirewall } from "./brevo.generated";
import { brightDataFirewall } from "./bright-data.generated";
import { browserbaseFirewall } from "./browserbase.generated";
import { browserlessFirewall } from "./browserless.generated";
import { bufferFirewall } from "./buffer.generated";
import { calComFirewall } from "./cal-com.generated";
import { calendlyFirewall } from "./calendly.generated";
import { canvaFirewall } from "./canva.generated";
import { chatwootFirewall } from "./chatwoot.generated";
import { clickupFirewall } from "./clickup.generated";
import { closeFirewall } from "./close.generated";
import { cloudflareFirewall } from "./cloudflare.generated";
import { codaFirewall } from "./coda.generated";
import { cronlyticFirewall } from "./cronlytic.generated";
import { customerIoFirewall } from "./customer-io.generated";
import { deepseekFirewall } from "./deepseek.generated";
import { deelFirewall } from "./deel.generated";
import { devtoFirewall } from "./devto.generated";
import { difyFirewall } from "./dify.generated";
import { discordFirewall } from "./discord.generated";
import { discordWebhookFirewall } from "./discord-webhook.generated";
import { docusignFirewall } from "./docusign.generated";
import { db9Firewall } from "./db9.generated";
import { drive9Firewall } from "./drive9.generated";
import { dropboxFirewall } from "./dropbox.generated";
import { dropboxSignFirewall } from "./dropbox-sign.generated";
import { duffelFirewall } from "./duffel.generated";
import { e2bFirewall } from "./e2b.generated";
import { elevenlabsFirewall } from "./elevenlabs.generated";
import { exaFirewall } from "./exa.generated";
import { exploriumFirewall } from "./explorium.generated";
import { falFirewall } from "./fal.generated";
import { figmaFirewall } from "./figma.generated";
import { firecrawlFirewall } from "./firecrawl.generated";
import { firefliesFirewall } from "./fireflies.generated";
import { freshdeskFirewall } from "./freshdesk.generated";
import { gammaFirewall } from "./gamma.generated";
import { garminConnectFirewall } from "./garmin-connect.generated";
import { githubFirewall } from "./github.generated";
import { gitlabFirewall } from "./gitlab.generated";
import { googleCalendarFirewall } from "./google-calendar.generated";
import { googleDocsFirewall } from "./google-docs.generated";
import { googleDriveFirewall } from "./google-drive.generated";
import { googleMeetFirewall } from "./google-meet.generated";
import { googleSheetsFirewall } from "./google-sheets.generated";
import { granolaFirewall } from "./granola.generated";
import { greenhouseFirewall } from "./greenhouse.generated";
import { groqFirewall } from "./groq.generated";
import { heygenFirewall } from "./heygen.generated";
import { heliconeFirewall } from "./helicone.generated";
import { htmlcsstoimageFirewall } from "./htmlcsstoimage.generated";
import { hubspotFirewall } from "./hubspot.generated";
import { huggingFaceFirewall } from "./hugging-face.generated";
import { humeFirewall } from "./hume.generated";
import { imgurFirewall } from "./imgur.generated";
import { instagramFirewall } from "./instagram.generated";
import { instantlyFirewall } from "./instantly.generated";
import { intercomFirewall } from "./intercom.generated";
import { intervalsIcuFirewall } from "./intervals-icu.generated";
import { jamFirewall } from "./jam.generated";
import { jiraFirewall } from "./jira.generated";
import { jotformFirewall } from "./jotform.generated";
import { klaviyoFirewall } from "./klaviyo.generated";
import { kommoFirewall } from "./kommo.generated";
import { larkFirewall } from "./lark.generated";
import { langfuseFirewall } from "./langfuse.generated";
import { langsmithFirewall } from "./langsmith.generated";
import { lineFirewall } from "./line.generated";
import { linearFirewall } from "./linear.generated";
import { loopsFirewall } from "./loops.generated";
import { lumaFirewall } from "./luma.generated";
import { mailchimpFirewall } from "./mailchimp.generated";
import { makeFirewall } from "./make.generated";
import { mailsacFirewall } from "./mailsac.generated";
import { manusFirewall } from "./manus.generated";
import { mem0Firewall } from "./mem0.generated";
import { mercuryFirewall } from "./mercury.generated";
import { metabaseFirewall } from "./metabase.generated";
import { metaAdsFirewall } from "./meta-ads.generated";
import { minimaxFirewall } from "./minimax.generated";
import { miroFirewall } from "./miro.generated";
import { mixpanelFirewall } from "./mixpanel.generated";
import { mondayFirewall } from "./monday.generated";
import { msg9Firewall } from "./msg9.generated";
import { n8nFirewall } from "./n8n.generated";
import { neonFirewall } from "./neon.generated";
import { notionFirewall } from "./notion.generated";
import { openaiFirewall } from "./openai.generated";
import { outlookCalendarFirewall } from "./outlook-calendar.generated";
import { outlookMailFirewall } from "./outlook-mail.generated";
import { pandadocFirewall } from "./pandadoc.generated";
import { pdf4meFirewall } from "./pdf4me.generated";
import { pdfcoFirewall } from "./pdfco.generated";
import { pineconeFirewall } from "./pinecone.generated";
import { pdforgeFirewall } from "./pdforge.generated";
import { perplexityFirewall } from "./perplexity.generated";
import { pipedriveFirewall } from "./pipedrive.generated";
import { plainFirewall } from "./plain.generated";
import { plausibleFirewall } from "./plausible.generated";
import { podchaserFirewall } from "./podchaser.generated";
import { posthogFirewall } from "./posthog.generated";
import { productlaneFirewall } from "./productlane.generated";
import { prismaPostgresFirewall } from "./prisma-postgres.generated";
import { pushinatorFirewall } from "./pushinator.generated";
import { qdrantFirewall } from "./qdrant.generated";
import { qiitaFirewall } from "./qiita.generated";
import { redditFirewall } from "./reddit.generated";
import { reporteiFirewall } from "./reportei.generated";
import { replicateFirewall } from "./replicate.generated";
import { resendFirewall } from "./resend.generated";
import { revenuecatFirewall } from "./revenuecat.generated";
import { runwayFirewall } from "./runway.generated";
import { salesforceFirewall } from "./salesforce.generated";
import { scrapeninjaFirewall } from "./scrapeninja.generated";
import { sentryFirewall } from "./sentry.generated";
import { serpapiFirewall } from "./serpapi.generated";
import { shopifyFirewall } from "./shopify.generated";
import { shortioFirewall } from "./shortio.generated";
import { stabilityAiFirewall } from "./stability-ai.generated";
import { similarwebFirewall } from "./similarweb.generated";
import { slackWebhookFirewall } from "./slack-webhook.generated";
import { spotifyFirewall } from "./spotify.generated";
import { stravaFirewall } from "./strava.generated";
import { strapiFirewall } from "./strapi.generated";
import { streakFirewall } from "./streak.generated";
import { stripeFirewall } from "./stripe.generated";
import { supabaseFirewall } from "./supabase.generated";
import { supadataFirewall } from "./supadata.generated";
import { tavilyFirewall } from "./tavily.generated";
import { testOauthFirewall } from "./test-oauth.generated";
import { tldvFirewall } from "./tldv.generated";
import { todoistFirewall } from "./todoist.generated";
import { togetherFirewall } from "./together.generated";
import { twentyFirewall } from "./twenty.generated";
import { typeformFirewall } from "./typeform.generated";
import { v0Firewall } from "./v0.generated";
import { wandbFirewall } from "./wandb.generated";
import { webflowFirewall } from "./webflow.generated";
import { wixFirewall } from "./wix.generated";
import { workosFirewall } from "./workos.generated";
import { wrikeFirewall } from "./wrike.generated";
import { xFirewall } from "./x.generated";
import { xeroFirewall } from "./xero.generated";
import { youtubeFirewall } from "./youtube.generated";
import { zapierFirewall } from "./zapier.generated";
import { zapsignFirewall } from "./zapsign.generated";
import { zendeskFirewall } from "./zendesk.generated";
import { zepFirewall } from "./zep.generated";
import { zeptomailFirewall } from "./zeptomail.generated";
import { zoomFirewall } from "./zoom.generated";

// ── Permission categories ───────────────────────────────────────────────

export interface ConnectorCategories {
  /** Map of permission name to category label */
  categories: Record<string, string>;
  /** Display order of categories (first = top of list) */
  displayOrder: readonly string[];
}

export interface PermissionGroup<T extends { name: string }> {
  category: string;
  permissions: T[];
}

const CONNECTOR_FIREWALLS = {
  agentmail: agentmailFirewall,
  agentphone: agentphoneFirewall,
  amplitude: amplitudeFirewall,
  "anthropic-managed-agents": anthropicManagedAgentsFirewall,
  ahrefs: ahrefsFirewall,
  airtable: airtableFirewall,
  apollo: apolloFirewall,
  pika: pikaFirewall,
  apify: apifyFirewall,
  asana: asanaFirewall,
  attio: attioFirewall,
  atlassian: atlassianFirewall,
  axiom: axiomFirewall,
  bitrix: bitrixFirewall,
  "brave-search": braveSearchFirewall,
  brevo: brevoFirewall,
  "bright-data": brightDataFirewall,
  browserbase: browserbaseFirewall,
  browserless: browserlessFirewall,
  buffer: bufferFirewall,
  "cal-com": calComFirewall,
  calendly: calendlyFirewall,
  canva: canvaFirewall,
  chatwoot: chatwootFirewall,
  clickup: clickupFirewall,
  close: closeFirewall,
  cloudflare: cloudflareFirewall,
  coda: codaFirewall,
  cronlytic: cronlyticFirewall,
  "customer-io": customerIoFirewall,
  deel: deelFirewall,
  deepseek: deepseekFirewall,
  devto: devtoFirewall,
  dify: difyFirewall,
  doppler: dopplerFirewall,
  infisical: infisicalFirewall,
  discord: discordFirewall,
  "discord-webhook": discordWebhookFirewall,
  docusign: docusignFirewall,
  db9: db9Firewall,
  drive9: drive9Firewall,
  dropbox: dropboxFirewall,
  "dropbox-sign": dropboxSignFirewall,
  duffel: duffelFirewall,
  e2b: e2bFirewall,
  elevenlabs: elevenlabsFirewall,
  exa: exaFirewall,
  explorium: exploriumFirewall,
  fal: falFirewall,
  figma: figmaFirewall,
  firecrawl: firecrawlFirewall,
  fireflies: firefliesFirewall,
  freshdesk: freshdeskFirewall,
  gamma: gammaFirewall,
  "garmin-connect": garminConnectFirewall,
  github: githubFirewall,
  gitlab: gitlabFirewall,
  gmail: gmailFirewall,
  "google-calendar": googleCalendarFirewall,
  "google-docs": googleDocsFirewall,
  "google-drive": googleDriveFirewall,
  "google-meet": googleMeetFirewall,
  "google-sheets": googleSheetsFirewall,
  granola: granolaFirewall,
  greenhouse: greenhouseFirewall,
  groq: groqFirewall,
  heygen: heygenFirewall,
  helicone: heliconeFirewall,
  htmlcsstoimage: htmlcsstoimageFirewall,
  hubspot: hubspotFirewall,
  "hugging-face": huggingFaceFirewall,
  hume: humeFirewall,
  imgur: imgurFirewall,
  instagram: instagramFirewall,
  instantly: instantlyFirewall,
  intercom: intercomFirewall,
  "intervals-icu": intervalsIcuFirewall,
  jam: jamFirewall,
  jira: jiraFirewall,
  jotform: jotformFirewall,
  klaviyo: klaviyoFirewall,
  kommo: kommoFirewall,
  lark: larkFirewall,
  langfuse: langfuseFirewall,
  langsmith: langsmithFirewall,
  line: lineFirewall,
  linear: linearFirewall,
  loops: loopsFirewall,
  luma: lumaFirewall,
  mailchimp: mailchimpFirewall,
  make: makeFirewall,
  mailsac: mailsacFirewall,
  manus: manusFirewall,
  mem0: mem0Firewall,
  mercury: mercuryFirewall,
  metabase: metabaseFirewall,
  "meta-ads": metaAdsFirewall,
  minimax: minimaxFirewall,
  miro: miroFirewall,
  mixpanel: mixpanelFirewall,
  monday: mondayFirewall,
  msg9: msg9Firewall,
  n8n: n8nFirewall,
  neon: neonFirewall,
  notion: notionFirewall,
  openai: openaiFirewall,
  "outlook-calendar": outlookCalendarFirewall,
  "outlook-mail": outlookMailFirewall,
  pandadoc: pandadocFirewall,
  pdf4me: pdf4meFirewall,
  pdfco: pdfcoFirewall,
  pinecone: pineconeFirewall,
  pdforge: pdforgeFirewall,
  perplexity: perplexityFirewall,
  pipedrive: pipedriveFirewall,
  plain: plainFirewall,
  plausible: plausibleFirewall,
  podchaser: podchaserFirewall,
  posthog: posthogFirewall,
  "prisma-postgres": prismaPostgresFirewall,
  productlane: productlaneFirewall,
  pushinator: pushinatorFirewall,
  qdrant: qdrantFirewall,
  qiita: qiitaFirewall,
  reddit: redditFirewall,
  reportei: reporteiFirewall,
  replicate: replicateFirewall,
  resend: resendFirewall,
  revenuecat: revenuecatFirewall,
  runway: runwayFirewall,
  salesforce: salesforceFirewall,
  scrapeninja: scrapeninjaFirewall,
  sentry: sentryFirewall,
  serpapi: serpapiFirewall,
  shopify: shopifyFirewall,
  shortio: shortioFirewall,
  "stability-ai": stabilityAiFirewall,
  similarweb: similarwebFirewall,
  slack: slackFirewall,
  "slack-webhook": slackWebhookFirewall,
  spotify: spotifyFirewall,
  strava: stravaFirewall,
  strapi: strapiFirewall,
  streak: streakFirewall,
  stripe: stripeFirewall,
  supabase: supabaseFirewall,
  supadata: supadataFirewall,
  tavily: tavilyFirewall,
  "test-oauth": testOauthFirewall,
  tldv: tldvFirewall,
  todoist: todoistFirewall,
  together: togetherFirewall,
  twenty: twentyFirewall,
  typeform: typeformFirewall,
  v0: v0Firewall,
  vercel: vercelFirewall,
  wandb: wandbFirewall,
  webflow: webflowFirewall,
  wix: wixFirewall,
  workos: workosFirewall,
  wrike: wrikeFirewall,
  x: xFirewall,
  xero: xeroFirewall,
  youtube: youtubeFirewall,
  zapier: zapierFirewall,
  zapsign: zapsignFirewall,
  zendesk: zendeskFirewall,
  zep: zepFirewall,
  zeptomail: zeptomailFirewall,
  zoom: zoomFirewall,
} as const satisfies Partial<Record<ConnectorType, FirewallConfig>>;

/**
 * Expand firewall placeholders to cover all secret names related to the
 * connector.  For each existing placeholder key, find related names via
 * environmentMapping (raw OAuth secret names and sibling aliases) and assign
 * the same placeholder value.
 */
function expandPlaceholders(
  firewall: FirewallConfig,
  connectorType: ConnectorType,
): FirewallConfig {
  if (!firewall.placeholders) return firewall;

  const mapping = getConnectorEnvironmentMapping(connectorType);
  if (Object.keys(mapping).length === 0) return firewall;

  const expanded: Record<string, string> = { ...firewall.placeholders };

  for (const [key, placeholderValue] of Object.entries(firewall.placeholders)) {
    // key is a mapped env var (e.g. GITHUB_TOKEN)
    // → add the raw secret name and any sibling aliases
    const valueRef = mapping[key];
    if (valueRef?.startsWith("$secrets.")) {
      const rawName = valueRef.slice("$secrets.".length);
      if (!expanded[rawName]) {
        expanded[rawName] = placeholderValue;
      }
      for (const [envVar, ref] of Object.entries(mapping)) {
        if (ref === valueRef && !expanded[envVar]) {
          expanded[envVar] = placeholderValue;
        }
      }
    }

    // key is a raw secret name → add all env vars that reference it
    const rawRef = `$secrets.${key}`;
    for (const [envVar, ref] of Object.entries(mapping)) {
      if (ref === rawRef && !expanded[envVar]) {
        expanded[envVar] = placeholderValue;
      }
    }
  }

  return { ...firewall, placeholders: expanded };
}

// Pre-compute expanded placeholders at module load time.
const EXPANDED_CONNECTOR_FIREWALLS = Object.fromEntries(
  Object.entries(CONNECTOR_FIREWALLS).map(([type, firewall]) => {
    return [type, expandPlaceholders(firewall, type as ConnectorType)];
  }),
) as typeof CONNECTOR_FIREWALLS;

/** Connector types that have a firewall config (subset of ConnectorType). */
export type FirewallConnectorType = keyof typeof CONNECTOR_FIREWALLS;

/**
 * Extract the union of permission names from a firewall config object.
 * Requires the config to be declared with `as const satisfies FirewallConfig`
 * so that permission name strings are preserved as literal types.
 */
export type PermissionNamesOf<T extends FirewallConfig> =
  T["apis"][number] extends { permissions?: infer P }
    ? P extends ReadonlyArray<{ name: infer N }>
      ? N extends string
        ? N
        : never
      : never
    : never;

const CONNECTOR_CATEGORIES: Partial<
  Record<FirewallConnectorType, ConnectorCategories>
> = {
  gmail: { categories: gmailCategories, displayOrder: gmailCategoryOrder },
  slack: { categories: slackCategories, displayOrder: slackCategoryOrder },
  vercel: { categories: vercelCategories, displayOrder: vercelCategoryOrder },
};

/** Get the category data for a connector type (null if uncategorized). */
export function getPermissionCategories(
  type: string,
): ConnectorCategories | null {
  return CONNECTOR_CATEGORIES[type as FirewallConnectorType] ?? null;
}

/**
 * Group permissions by their category for a given connector type.
 * Returns null when the connector has no category data (caller should
 * fall back to a flat list).
 */
export function groupPermissionsByCategory<T extends { name: string }>(
  permissions: T[],
  connectorType: string,
): PermissionGroup<T>[] | null {
  const categoryData = getPermissionCategories(connectorType);
  if (!categoryData) {
    return null;
  }

  const grouped = new Map<string, T[]>();
  for (const category of categoryData.displayOrder) {
    grouped.set(category, []);
  }

  for (const perm of permissions) {
    const category = categoryData.categories[perm.name];
    if (category) {
      const list = grouped.get(category);
      if (list) {
        list.push(perm);
      }
    }
  }

  return [...grouped.entries()]
    .filter(([, perms]) => {
      return perms.length > 0;
    })
    .map(([category, perms]) => {
      return { category, permissions: perms };
    });
}

/**
 * Connector types that do not have a firewall config.
 *
 * When adding a new ConnectorType, place it in either CONNECTOR_FIREWALLS
 * or this union. The compile-time assertions below will fail if a
 * ConnectorType is missing from both, or if a type is listed here
 * that already has a firewall config.
 */
export type NonFirewallConnectorType =
  // Signature-based auth — requires computing signatures, not simple header injection
  | "cloudinary" // SHA signature in form body + api_key param
  | "minio" // AWS Signature V4
  // Other
  | "computer"; // not an API connector

/**
 * Compile-time exhaustiveness checks.
 *
 * ValidateNonFirewall: ensures NonFirewallConnectorType only contains
 * connectors that are NOT in FirewallConnectorType.
 *
 * ValidateExhaustive: ensures every ConnectorType is in either
 * FirewallConnectorType or NonFirewallConnectorType.
 */
type ValidateNonFirewall<
  T extends Exclude<ConnectorType, FirewallConnectorType> =
    NonFirewallConnectorType,
> = T;
type ValidateExhaustive<
  T extends never = Exclude<
    ConnectorType,
    FirewallConnectorType | NonFirewallConnectorType
  >,
> = T;
export type ConnectorTypeCoverage = ValidateNonFirewall & ValidateExhaustive;

/** Check if a connector type has a firewall config. */
export function isFirewallConnectorType(
  type: string,
): type is FirewallConnectorType {
  return type in CONNECTOR_FIREWALLS;
}

/** Get the firewall config for a connector type (placeholders pre-expanded). */
export function getConnectorFirewall(
  type: FirewallConnectorType,
): FirewallConfig {
  return EXPANDED_CONNECTOR_FIREWALLS[type];
}

/**
 * Per-connector default-allowed permission lists.
 *
 * Each entry is a readonly array of permission names that are allowed by
 * default. Permissions NOT in the array are denied. Connectors without
 * an entry here have no defaults (all permissions allowed).
 *
 * These arrays are generated alongside the firewall configs — see each
 * connector's generator (e.g. slack.ts) for the source of truth.
 */
const DEFAULT_ALLOWED: Partial<
  Record<FirewallConnectorType, ReadonlyArray<string>>
> = {
  gmail: gmailDefaultAllowed,
  slack: slackDefaultAllowed,
};

/**
 * Get the default firewall policies for a connector type.
 *
 * Returns a ConnectorPolicy with all permissions mapped. Connectors with a
 * default-allowed list get "allow"/"deny" selectively; others get all-allow.
 * `unknownPolicy` defaults to "allow".
 */
export function getDefaultFirewallPolicies(
  type: FirewallConnectorType,
): FirewallPolicy {
  const allowed = DEFAULT_ALLOWED[type];
  const allowSet = allowed ? new Set<string>(allowed) : null;
  const config = getConnectorFirewall(type);
  const policies: Record<string, FirewallPolicyValue> = {};
  for (const api of config.apis) {
    if (api.permissions) {
      for (const p of api.permissions) {
        policies[p.name] = !allowSet || allowSet.has(p.name) ? "allow" : "deny";
      }
    }
  }
  return { policies, unknownPolicy: "allow" };
}

/**
 * Merge stored firewall policies with per-connector defaults.
 *
 * For each connector, builds a full default policy (all-allow for connectors
 * without a default-allowed list, selective for those with one), then layers
 * stored overrides on top. Merges both `policies` and `unknownPolicy`.
 */
export function resolveFirewallPolicies(
  stored: FirewallPolicies | null,
  connectors: string[],
): FirewallPolicies | null {
  let resolved: FirewallPolicies | null = stored;
  for (const connector of connectors) {
    if (!isFirewallConnectorType(connector)) continue;
    const defaults = getDefaultFirewallPolicies(connector);
    const existing = resolved?.[connector];
    resolved = {
      ...resolved,
      [connector]: {
        policies: { ...defaults.policies, ...existing?.policies },
        ...(existing?.unknownPolicy !== undefined
          ? { unknownPolicy: existing.unknownPolicy }
          : { unknownPolicy: defaults.unknownPolicy }),
      },
    };
  }
  return resolved;
}

/**
 * Map every built-in connector's `api.base` host to its connector type.
 *
 * Used to reject org custom connectors whose prefix host collides with a
 * built-in. The returned map lets callers produce a user-facing error that
 * names the conflicting built-in.
 *
 * Bases that embed runtime template variables (e.g. `${{ vars.JIRA_DOMAIN }}`)
 * or otherwise fail URL parsing are skipped — there's no fixed host to
 * compare against, and the conflict check is best-effort anyway (mitm-level
 * matching remains the final line of defense).
 */
export function getAllBuiltinConnectorHosts(): Map<
  string,
  FirewallConnectorType
> {
  const hosts = new Map<string, FirewallConnectorType>();
  for (const [type, firewall] of Object.entries(CONNECTOR_FIREWALLS) as [
    FirewallConnectorType,
    FirewallConfig,
  ][]) {
    for (const api of firewall.apis) {
      if (api.base.includes("${{")) continue;
      let host: string;
      try {
        host = new URL(api.base).host;
      } catch {
        continue;
      }
      if (!hosts.has(host)) {
        hosts.set(host, type);
      }
    }
  }
  return hosts;
}

/**
 * Human-readable display name for a built-in connector type
 * (e.g. "GitHub", "Google Drive"). Falls back to the type slug if
 * `CONNECTOR_TYPES` has no entry.
 */
export function getBuiltinConnectorDisplayName(
  type: FirewallConnectorType,
): string {
  return CONNECTOR_TYPES[type]?.label ?? type;
}

export {
  BILLABLE_CONNECTORS,
  type BillableConnector,
} from "./billable-connectors";
