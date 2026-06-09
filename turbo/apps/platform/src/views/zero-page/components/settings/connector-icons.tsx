import {
  CONNECTOR_TYPE_KEYS,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { cn } from "@vm0/ui";

const CONNECTOR_ICON_ALIASES = {
  "slack-webhook": "slack",
  "railway-project": "railway",
  "test-oauth-device": "test-oauth",
} as const satisfies Partial<Record<ConnectorType, ConnectorType>>;

export const CONNECTOR_ICONS: Readonly<Record<ConnectorType, string>> =
  Object.freeze(
    (() => {
      const allIcons = Object.fromEntries(
        Object.entries(
          import.meta.glob<string>("./icons/*.{svg,png}", {
            eager: true,
            import: "default",
          }),
        ).map(([path, url]) => {
          return [
            path.replace("./icons/", "").replace(/\.(svg|png)$/, ""),
            url,
          ];
        }),
      );

      const connectorKeys = CONNECTOR_TYPE_KEYS;
      const filtered: Record<string, string> = {};
      for (const key of connectorKeys) {
        const iconKey =
          key in CONNECTOR_ICON_ALIASES
            ? CONNECTOR_ICON_ALIASES[key as keyof typeof CONNECTOR_ICON_ALIASES]
            : key;
        const icon = allIcons[iconKey];
        if (typeof icon !== "string") {
          throw new Error(
            `Missing SVG icon for connector type "${key}". Add icons/${iconKey}.svg.`,
          );
        }
        filtered[key] = icon;
      }

      return filtered as Record<ConnectorType, string>;
    })(),
  );

/** Official Slack Mark ships with a 270×270 viewBox whose artwork only fills the central ~45%.
 *  Callers render it inside an `overflow-hidden` box at layout size, and we scale the `<img>` up
 *  so the visible mark matches the box. */
const CONNECTOR_ICON_LOOSE_VIEWBOX = {
  slack: true,
  "slack-webhook": true,
} as const;

function connectorIconHasLooseViewBox(type: ConnectorType): boolean {
  return type in CONNECTOR_ICON_LOOSE_VIEWBOX;
}

/**
 * Multi-color, gradient, and distinctive single-color brand marks: skip `zero-icon-mono`
 * so `filter: invert(1)` does not distort their official colors.
 * Dark single-fill logos (e.g. navy) are *not* listed here—they invert for contrast on dark UI.
 */
const CONNECTOR_ICON_COLORFUL = {
  adzuna: true,
  ahrefs: true,
  agora: true,
  airtable: true,
  "altium-365": true,
  alchemy: true,
  amadeus: true,
  amplitude: true,
  "anthropic-managed-agents": true,
  apify: true,
  asana: true,
  ashby: true,
  atlassian: true,
  aviationstack: true,
  azure: true,
  base44: true,
  bedrock: true,
  bitrefill: true,
  bitrix: true,
  bland: true,
  "brave-search": true,
  "bright-data": true,
  brevo: true,
  browserbase: true,
  browserstack: true,
  "cal-com": true,
  calendly: true,
  canva: true,
  chatglm: true,
  chatwoot: true,
  checkr: true,
  "claude-code": true,
  clearbit: true,
  clickup: true,
  close: true,
  cloudflare: true,
  cloudinary: true,
  coda: true,
  coingecko: true,
  coresignal: true,
  cronlytic: true,
  crustdata: true,
  cursor: true,
  "customer-io": true,
  deepseek: true,
  defillama: true,
  doubao: true,
  dify: true,
  discord: true,
  "discord-webhook": true,
  doppler: true,
  docusign: true,
  dropbox: true,
  "dropbox-sign": true,
  e2b: true,
  etherscan: true,
  etsy: true,
  exa: true,
  explorium: true,
  fal: true,
  figma: true,
  firecrawl: true,
  fireflies: true,
  flightaware: true,
  freshdesk: true,
  gamma: true,
  "garmin-connect": true,
  gemini: true,
  gitlab: true,
  gmail: true,
  gong: true,
  "google-ads": true,
  "google-calendar": true,
  "google-docs": true,
  "google-drive": true,
  "google-meet": true,
  "google-sheets": true,
  granola: true,
  greenhouse: true,
  groq: true,
  gumroad: true,
  helicone: true,
  heygen: true,
  hitem3d: true,
  honcho: true,
  hubspot: true,
  "hugging-face": true,
  hunter: true,
  imgur: true,
  instagram: true,
  instantly: true,
  "intervals-icu": true,
  ironclad: true,
  jam: true,
  jira: true,
  jotform: true,
  kommo: true,
  lark: true,
  langfuse: true,
  langsmith: true,
  line: true,
  linear: true,
  loops: true,
  mailchimp: true,
  mailsac: true,
  manus: true,
  meshy: true,
  "meta-ads": true,
  metabase: true,
  minimax: true,
  minio: true,
  miro: true,
  mixpanel: true,
  modal: true,
  monday: true,
  msg9: true,
  n8n: true,
  neon: true,
  netdata: true,
  nyne: true,
  openweather: true,
  "outlook-calendar": true,
  "outlook-mail": true,
  pandadoc: true,
  pdf4me: true,
  pdfco: true,
  pdforge: true,
  "people-data-labs": true,
  perplexity: true,
  pipedrive: true,
  pipedream: true,
  plain: true,
  plausible: true,
  podchaser: true,
  porkbun: true,
  posthog: true,
  productlane: true,
  printful: true,
  qdrant: true,
  qiita: true,
  reap: true,
  recraft: true,
  reddit: true,
  reducto: true,
  rentcast: true,
  reportei: true,
  salesforce: true,
  serpapi: true,
  servicenow: true,
  shopify: true,
  shortio: true,
  similarweb: true,
  slack: true,
  "slack-webhook": true,
  snowflake: true,
  sociavault: true,
  spotify: true,
  sproutgigs: true,
  "stability-ai": true,
  strapi: true,
  strava: true,
  streak: true,
  stripe: true,
  supabase: true,
  ticketmaster: true,
  tldv: true,
  todoist: true,
  together: true,
  tripo: true,
  twilio: true,
  wandb: true,
  webflow: true,
  weread: true,
  "whale-alert": true,
  workos: true,
  wrike: true,
  xero: true,
  youtube: true,
  zapier: true,
  zapsign: true,
  zep: true,
  zeptomail: true,
  zoom: true,
} as const;

function connectorIconSkipsDarkInvert(type: ConnectorType): boolean {
  return type in CONNECTOR_ICON_COLORFUL;
}

/**
 * Connector mark in a square slot. The asset scales with `object-contain` so the
 * drawable uses the full `size×size` box (e.g. a 20×28 logo fills height in a 28×28 slot).
 */
export function ConnectorIcon({
  type,
  size = 28,
}: {
  type: ConnectorType;
  size?: number;
}) {
  const icon = CONNECTOR_ICONS[type];
  const looseViewBox = connectorIconHasLooseViewBox(type);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        looseViewBox && "overflow-hidden",
      )}
      style={{ width: size, height: size }}
    >
      <img
        src={icon}
        alt=""
        decoding="async"
        className={cn(
          "block h-full w-full max-h-full max-w-full object-contain",
          !connectorIconSkipsDarkInvert(type) && "zero-icon-mono",
          looseViewBox && "scale-[2.2]",
        )}
      />
    </span>
  );
}
