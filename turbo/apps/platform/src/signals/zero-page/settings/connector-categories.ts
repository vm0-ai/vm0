import type { ConnectorType } from "@vm0/core";

type ConnectorDisplayCategory =
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

const CONNECTOR_CATEGORY_ORDER: readonly ConnectorDisplayCategory[] = [
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

const CONNECTOR_CATEGORY_LABELS: Record<ConnectorDisplayCategory, string> = {
  "ai-general-models": "AI: General Models and Reasoning",
  "ai-image-video": "AI: Image / Video Generation",
  "ai-voice-audio": "AI: Voice / Audio",
  "ai-agent-apps": "AI: Agent Platforms and AI Apps",
  "ai-memory-tracing-eval": "AI: Memory / Tracing / Evaluation",
  "communication-collaboration": "Communication and Collaboration",
  "meetings-scheduling": "Meetings and Scheduling",
  "docs-files-knowledge": "Docs, Files, and Knowledge",
  "engineering-team-execution": "Engineering and Team Execution",
  "sales-crm-business-operations": "Sales, CRM, and Business Operations",
  "marketing-content-growth": "Marketing, Content, and Growth",
  "data-automation-infrastructure": "Data, Automation, and Infrastructure",
};

const CONNECTOR_CATEGORY_BY_TYPE = {
  agentmail: "communication-collaboration",
  agentphone: "communication-collaboration",
  ahrefs: "marketing-content-growth",
  airtable: "docs-files-knowledge",
  amplitude: "data-automation-infrastructure",
  "anthropic-managed-agents": "ai-agent-apps",
  apify: "data-automation-infrastructure",
  apollo: "sales-crm-business-operations",
  asana: "engineering-team-execution",
  atlassian: "engineering-team-execution",
  attio: "sales-crm-business-operations",
  axiom: "data-automation-infrastructure",
  bitrix: "sales-crm-business-operations",
  "brave-search": "data-automation-infrastructure",
  brevo: "communication-collaboration",
  "bright-data": "data-automation-infrastructure",
  browserbase: "data-automation-infrastructure",
  browserless: "data-automation-infrastructure",
  buffer: "marketing-content-growth",
  "cal-com": "meetings-scheduling",
  calendly: "meetings-scheduling",
  canva: "docs-files-knowledge",
  chatwoot: "communication-collaboration",
  clickup: "engineering-team-execution",
  close: "sales-crm-business-operations",
  cloudflare: "engineering-team-execution",
  cloudinary: "marketing-content-growth",
  coda: "docs-files-knowledge",
  computer: "engineering-team-execution",
  cronlytic: "data-automation-infrastructure",
  "customer-io": "communication-collaboration",
  db9: "data-automation-infrastructure",
  deel: "sales-crm-business-operations",
  deepseek: "ai-general-models",
  devto: "marketing-content-growth",
  dify: "ai-agent-apps",
  discord: "communication-collaboration",
  "discord-webhook": "communication-collaboration",
  docusign: "data-automation-infrastructure",
  doppler: "engineering-team-execution",
  drive9: "docs-files-knowledge",
  dropbox: "docs-files-knowledge",
  "dropbox-sign": "data-automation-infrastructure",
  duffel: "data-automation-infrastructure",
  e2b: "data-automation-infrastructure",
  elevenlabs: "ai-voice-audio",
  etsy: "data-automation-infrastructure",
  exa: "data-automation-infrastructure",
  explorium: "sales-crm-business-operations",
  fal: "ai-image-video",
  figma: "docs-files-knowledge",
  firecrawl: "data-automation-infrastructure",
  fireflies: "meetings-scheduling",
  freshdesk: "communication-collaboration",
  gamma: "marketing-content-growth",
  "garmin-connect": "data-automation-infrastructure",
  github: "engineering-team-execution",
  gitlab: "engineering-team-execution",
  gmail: "communication-collaboration",
  "google-calendar": "meetings-scheduling",
  "google-docs": "docs-files-knowledge",
  "google-drive": "docs-files-knowledge",
  "google-meet": "meetings-scheduling",
  "google-sheets": "docs-files-knowledge",
  granola: "meetings-scheduling",
  greenhouse: "sales-crm-business-operations",
  groq: "ai-general-models",
  helicone: "ai-memory-tracing-eval",
  heygen: "marketing-content-growth",
  htmlcsstoimage: "marketing-content-growth",
  hubspot: "sales-crm-business-operations",
  "hugging-face": "ai-general-models",
  hume: "ai-voice-audio",
  imgur: "marketing-content-growth",
  infisical: "engineering-team-execution",
  instagram: "marketing-content-growth",
  instantly: "communication-collaboration",
  intercom: "communication-collaboration",
  "intervals-icu": "meetings-scheduling",
  jam: "engineering-team-execution",
  jira: "engineering-team-execution",
  jotform: "data-automation-infrastructure",
  klaviyo: "marketing-content-growth",
  kommo: "sales-crm-business-operations",
  langfuse: "ai-memory-tracing-eval",
  langsmith: "ai-memory-tracing-eval",
  lark: "communication-collaboration",
  line: "communication-collaboration",
  linear: "engineering-team-execution",
  loops: "communication-collaboration",
  luma: "ai-image-video",
  mailchimp: "communication-collaboration",
  mailsac: "communication-collaboration",
  make: "data-automation-infrastructure",
  manus: "ai-agent-apps",
  mem0: "ai-memory-tracing-eval",
  mercury: "sales-crm-business-operations",
  "meta-ads": "marketing-content-growth",
  metabase: "data-automation-infrastructure",
  minimax: "ai-general-models",
  minio: "docs-files-knowledge",
  miro: "docs-files-knowledge",
  mixpanel: "data-automation-infrastructure",
  monday: "engineering-team-execution",
  msg9: "communication-collaboration",
  n8n: "data-automation-infrastructure",
  neon: "data-automation-infrastructure",
  notion: "docs-files-knowledge",
  onyx: "docs-files-knowledge",
  openai: "ai-general-models",
  "outlook-calendar": "meetings-scheduling",
  "outlook-mail": "communication-collaboration",
  pandadoc: "data-automation-infrastructure",
  pdf4me: "data-automation-infrastructure",
  pdfco: "data-automation-infrastructure",
  pdforge: "data-automation-infrastructure",
  perplexity: "data-automation-infrastructure",
  pika: "ai-image-video",
  pinecone: "data-automation-infrastructure",
  pipedrive: "sales-crm-business-operations",
  plain: "communication-collaboration",
  plausible: "data-automation-infrastructure",
  podchaser: "data-automation-infrastructure",
  posthog: "data-automation-infrastructure",
  "prisma-postgres": "data-automation-infrastructure",
  productlane: "sales-crm-business-operations",
  pushinator: "communication-collaboration",
  qdrant: "data-automation-infrastructure",
  qiita: "marketing-content-growth",
  reddit: "data-automation-infrastructure",
  replicate: "ai-image-video",
  reportei: "marketing-content-growth",
  resend: "communication-collaboration",
  revenuecat: "data-automation-infrastructure",
  runway: "ai-image-video",
  salesforce: "sales-crm-business-operations",
  scrapeninja: "data-automation-infrastructure",
  sentry: "engineering-team-execution",
  serpapi: "data-automation-infrastructure",
  shopify: "data-automation-infrastructure",
  shortio: "marketing-content-growth",
  similarweb: "marketing-content-growth",
  slack: "communication-collaboration",
  "slack-webhook": "communication-collaboration",
  spotify: "data-automation-infrastructure",
  "stability-ai": "ai-image-video",
  strapi: "docs-files-knowledge",
  strava: "data-automation-infrastructure",
  streak: "sales-crm-business-operations",
  stripe: "data-automation-infrastructure",
  supabase: "data-automation-infrastructure",
  supadata: "data-automation-infrastructure",
  tavily: "data-automation-infrastructure",
  "test-oauth": "data-automation-infrastructure",
  tldv: "meetings-scheduling",
  todoist: "engineering-team-execution",
  together: "ai-general-models",
  twenty: "sales-crm-business-operations",
  typeform: "data-automation-infrastructure",
  v0: "ai-agent-apps",
  vercel: "engineering-team-execution",
  wandb: "ai-memory-tracing-eval",
  webflow: "marketing-content-growth",
  wix: "marketing-content-growth",
  workos: "engineering-team-execution",
  wrike: "engineering-team-execution",
  x: "marketing-content-growth",
  xero: "data-automation-infrastructure",
  youtube: "marketing-content-growth",
  zapier: "data-automation-infrastructure",
  zapsign: "data-automation-infrastructure",
  zendesk: "communication-collaboration",
  zep: "ai-memory-tracing-eval",
  zeptomail: "communication-collaboration",
  zoom: "meetings-scheduling",
} as const satisfies Record<ConnectorType, ConnectorDisplayCategory>;

interface ConnectorCategorySection<T> {
  category: ConnectorDisplayCategory;
  label: string;
  connectors: T[];
}

export function getConnectorDisplayCategory(
  type: ConnectorType,
): ConnectorDisplayCategory {
  return CONNECTOR_CATEGORY_BY_TYPE[type];
}

export function groupConnectorsByCategory<
  T extends {
    category: ConnectorDisplayCategory;
    connected: boolean;
    label: string;
  },
>(connectors: readonly T[]): ConnectorCategorySection<T>[] {
  const grouped = new Map<ConnectorDisplayCategory, T[]>();

  for (const connector of connectors) {
    const items = grouped.get(connector.category);
    if (items) {
      items.push(connector);
    } else {
      grouped.set(connector.category, [connector]);
    }
  }

  return CONNECTOR_CATEGORY_ORDER.flatMap((category) => {
    const items = grouped.get(category);
    if (!items || items.length === 0) {
      return [];
    }
    const sorted = [...items].sort((a, b) => {
      if (a.connected !== b.connected) {
        return a.connected ? -1 : 1;
      }
      return a.label.localeCompare(b.label);
    });
    return [
      {
        category,
        label: CONNECTOR_CATEGORY_LABELS[category],
        connectors: sorted,
      },
    ];
  });
}
