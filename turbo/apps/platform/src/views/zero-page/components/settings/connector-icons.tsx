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
 * Multi-color / gradient brand marks: skip `zero-icon-mono` so `filter: invert(1)` does not distort them.
 * Dark single-fill logos (e.g. navy) are *not* listed here—they invert for contrast on dark UI.
 */
const CONNECTOR_ICON_COLORFUL = {
  adzuna: true,
  ahrefs: true,
  agora: true,
  airtable: true,
  alchemy: true,
  amadeus: true,
  amplitude: true,
  anthropic: true,
  apify: true,
  asana: true,
  ashby: true,
  azure: true,
  base44: true,
  bedrock: true,
  bentoml: true,
  bitrefill: true,
  bitrix: true,
  bland: true,
  "brave-search": true,
  brevo: true,
  browserbase: true,
  calendly: true,
  canva: true,
  chatglm: true,
  chatwoot: true,
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
  "google-ads": true,
  "google-calendar": true,
  "google-docs": true,
  "google-drive": true,
  "google-meet": true,
  "google-sheets": true,
  granola: true,
  greenhouse: true,
  helicone: true,
  heygen: true,
  honcho: true,
  hubspot: true,
  "hugging-face": true,
  imgur: true,
  instagram: true,
  instantly: true,
  "intervals-icu": true,
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
  mem0: true,
  meshy: true,
  "meta-ads": true,
  minimax: true,
  minio: true,
  monday: true,
  moss: true,
  n8n: true,
  neon: true,
  pandadoc: true,
  parallel: true,
  pdf4me: true,
  pdfco: true,
  "people-data-labs": true,
  pinecone: true,
  pipedream: true,
  plain: true,
  plausible: true,
  podchaser: true,
  porkbun: true,
  posthog: true,
  printful: true,
  qdrant: true,
  qiita: true,
  reap: true,
  recraft: true,
  reddit: true,
  rentcast: true,
  reportei: true,
  salesforce: true,
  serpapi: true,
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

/** Wordmark uses `currentColor` (theme foreground); blue dot stays `#2c71f0` (full invert would ruin it). */
function DeelConnectorMark({ className }: { className?: string }) {
  return (
    <svg
      fill="none"
      viewBox="0 -.059 74.873 72.014"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        d="m23.862 71.955c-4.564 0-8.639-1.115-12.224-3.348-3.586-2.232-6.422-5.284-8.509-9.157-2.086-3.875-3.129-8.272-3.129-13.196 0-4.923 1.043-9.289 3.13-13.096 2.086-3.873 4.922-6.893 8.508-9.06 3.585-2.231 7.66-3.347 12.224-3.347 3.65 0 6.845.689 9.584 2.067 2.194 1.105 4.054 2.569 5.579 4.39.345.414 1.07.18 1.07-.358v-23.925c0-.259.182-.482.436-.535l11.423-2.378c.34-.071.66.188.66.535v69.68a.547.547 0 0 1 -.548.547h-10.151a.547.547 0 0 1 -.537-.442l-1.04-5.312c-.092-.47-.709-.61-1.014-.241-1.458 1.758-3.287 3.33-5.487 4.715-2.543 1.64-5.868 2.461-9.975 2.461zm2.64-11.028c4.042 0 7.335-1.346 9.877-4.038 2.608-2.757 3.912-6.269 3.912-10.536s-1.304-7.746-3.912-10.438c-2.542-2.757-5.835-4.136-9.877-4.136-3.977 0-7.27 1.346-9.877 4.037-2.608 2.692-3.912 6.171-3.912 10.438s1.304 7.78 3.912 10.537 5.9 4.136 9.877 4.136z"
        fill="currentColor"
      />
      <path
        d="m66.445 70.575c4.655 0 8.428-3.799 8.428-8.486 0-4.686-3.774-8.485-8.428-8.485s-8.427 3.799-8.427 8.485c0 4.687 3.773 8.486 8.427 8.486z"
        fill="#2c71f0"
      />
    </svg>
  );
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
  if (type === "deel") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center text-foreground"
        style={{ width: size, height: size }}
      >
        <DeelConnectorMark className="block h-full w-full max-h-full max-w-full object-contain" />
      </span>
    );
  }

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
