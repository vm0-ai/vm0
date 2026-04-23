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

interface ConnectorCategorySection<T> {
  category: ConnectorDisplayCategory;
  label: string;
  connectors: T[];
}

function getConnectorCategoryLabel(category: ConnectorDisplayCategory): string {
  switch (category) {
    case "ai-general-models":
      return "AI: General Models and Reasoning";
    case "ai-image-video":
      return "AI: Image / Video Generation";
    case "ai-voice-audio":
      return "AI: Voice / Audio";
    case "ai-agent-apps":
      return "AI: Agent Platforms and AI Apps";
    case "ai-memory-tracing-eval":
      return "AI: Memory / Tracing / Evaluation";
    case "communication-collaboration":
      return "Communication and Collaboration";
    case "meetings-scheduling":
      return "Meetings and Scheduling";
    case "docs-files-knowledge":
      return "Docs, Files, and Knowledge";
    case "engineering-team-execution":
      return "Engineering and Team Execution";
    case "sales-crm-business-operations":
      return "Sales, CRM, and Business Operations";
    case "marketing-content-growth":
      return "Marketing, Content, and Growth";
    case "data-automation-infrastructure":
      return "Data, Automation, and Infrastructure";
  }
}

export function getConnectorDisplayCategory(
  type: ConnectorType,
): ConnectorDisplayCategory {
  switch (type) {
    case "agentmail":
    case "agentphone":
    case "brevo":
    case "chatwoot":
    case "customer-io":
    case "discord":
    case "discord-webhook":
    case "freshdesk":
    case "gmail":
    case "instantly":
    case "intercom":
    case "lark":
    case "line":
    case "loops":
    case "mailchimp":
    case "mailsac":
    case "msg9":
    case "outlook-mail":
    case "plain":
    case "pushinator":
    case "resend":
    case "slack":
    case "slack-webhook":
    case "zendesk":
    case "zeptomail":
      return "communication-collaboration";
    case "cal-com":
    case "calendly":
    case "fireflies":
    case "google-calendar":
    case "google-meet":
    case "granola":
    case "intervals-icu":
    case "outlook-calendar":
    case "tldv":
    case "zoom":
      return "meetings-scheduling";
    case "airtable":
    case "canva":
    case "coda":
    case "drive9":
    case "dropbox":
    case "figma":
    case "google-docs":
    case "google-drive":
    case "google-sheets":
    case "minio":
    case "miro":
    case "notion":
    case "onyx":
    case "strapi":
      return "docs-files-knowledge";
    case "asana":
    case "atlassian":
    case "clickup":
    case "cloudflare":
    case "computer":
    case "doppler":
    case "github":
    case "gitlab":
    case "infisical":
    case "jam":
    case "jira":
    case "linear":
    case "monday":
    case "sentry":
    case "todoist":
    case "vercel":
    case "workos":
    case "wrike":
      return "engineering-team-execution";
    case "apollo":
    case "attio":
    case "bitrix":
    case "close":
    case "deel":
    case "explorium":
    case "greenhouse":
    case "hubspot":
    case "kommo":
    case "mercury":
    case "pipedrive":
    case "productlane":
    case "salesforce":
    case "streak":
    case "twenty":
      return "sales-crm-business-operations";
    case "ahrefs":
    case "buffer":
    case "cloudinary":
    case "devto":
    case "gamma":
    case "heygen":
    case "htmlcsstoimage":
    case "imgur":
    case "instagram":
    case "klaviyo":
    case "meta-ads":
    case "qiita":
    case "reportei":
    case "shortio":
    case "similarweb":
    case "webflow":
    case "wix":
    case "x":
    case "youtube":
      return "marketing-content-growth";
    case "openai":
    case "deepseek":
    case "groq":
    case "hugging-face":
    case "minimax":
    case "together":
      return "ai-general-models";
    case "fal":
    case "luma":
    case "pika":
    case "replicate":
    case "runway":
    case "stability-ai":
      return "ai-image-video";
    case "elevenlabs":
    case "hume":
      return "ai-voice-audio";
    case "anthropic-managed-agents":
    case "dify":
    case "manus":
    case "v0":
      return "ai-agent-apps";
    case "helicone":
    case "langfuse":
    case "langsmith":
    case "mem0":
    case "wandb":
    case "zep":
      return "ai-memory-tracing-eval";
    case "amplitude":
    case "apify":
    case "axiom":
    case "brave-search":
    case "bright-data":
    case "browserbase":
    case "browserless":
    case "cronlytic":
    case "db9":
    case "docusign":
    case "dropbox-sign":
    case "duffel":
    case "e2b":
    case "etsy":
    case "exa":
    case "firecrawl":
    case "garmin-connect":
    case "jotform":
    case "make":
    case "metabase":
    case "mixpanel":
    case "n8n":
    case "neon":
    case "pandadoc":
    case "pdf4me":
    case "pdfco":
    case "pdforge":
    case "perplexity":
    case "pinecone":
    case "plausible":
    case "podchaser":
    case "posthog":
    case "prisma-postgres":
    case "qdrant":
    case "reddit":
    case "revenuecat":
    case "scrapeninja":
    case "serpapi":
    case "shopify":
    case "spotify":
    case "strava":
    case "stripe":
    case "supabase":
    case "supadata":
    case "tavily":
    case "test-oauth":
    case "typeform":
    case "xero":
    case "zapier":
    case "zapsign":
      return "data-automation-infrastructure";
  }
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
        label: getConnectorCategoryLabel(category),
        connectors: sorted,
      },
    ];
  });
}
