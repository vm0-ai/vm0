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

const COMMUNICATION_COLLABORATION_TYPES = [
  "agentmail",
  "agentphone",
  "brevo",
  "chatwoot",
  "customer-io",
  "discord",
  "discord-webhook",
  "freshdesk",
  "gmail",
  "instantly",
  "intercom",
  "lark",
  "line",
  "loops",
  "mailchimp",
  "mailsac",
  "msg9",
  "outlook-mail",
  "plain",
  "pushinator",
  "resend",
  "slack",
  "slack-webhook",
  "zendesk",
  "zeptomail",
] as const satisfies readonly ConnectorType[];

const MEETINGS_SCHEDULING_TYPES = [
  "cal-com",
  "calendly",
  "fireflies",
  "google-calendar",
  "google-meet",
  "granola",
  "intervals-icu",
  "outlook-calendar",
  "tldv",
  "zoom",
] as const satisfies readonly ConnectorType[];

const DOCS_FILES_KNOWLEDGE_TYPES = [
  "airtable",
  "canva",
  "coda",
  "drive9",
  "dropbox",
  "figma",
  "google-docs",
  "google-drive",
  "google-sheets",
  "minio",
  "miro",
  "notion",
  "onyx",
  "strapi",
] as const satisfies readonly ConnectorType[];

const ENGINEERING_TEAM_EXECUTION_TYPES = [
  "asana",
  "atlassian",
  "clickup",
  "cloudflare",
  "computer",
  "doppler",
  "github",
  "gitlab",
  "infisical",
  "jam",
  "jira",
  "linear",
  "monday",
  "sentry",
  "todoist",
  "vercel",
  "workos",
  "wrike",
] as const satisfies readonly ConnectorType[];

const SALES_CRM_BUSINESS_OPERATIONS_TYPES = [
  "apollo",
  "attio",
  "bitrix",
  "close",
  "deel",
  "explorium",
  "greenhouse",
  "hubspot",
  "kommo",
  "mercury",
  "pipedrive",
  "productlane",
  "salesforce",
  "streak",
  "twenty",
] as const satisfies readonly ConnectorType[];

const MARKETING_CONTENT_GROWTH_TYPES = [
  "ahrefs",
  "buffer",
  "cloudinary",
  "devto",
  "gamma",
  "heygen",
  "htmlcsstoimage",
  "imgur",
  "instagram",
  "klaviyo",
  "meta-ads",
  "qiita",
  "reportei",
  "shortio",
  "similarweb",
  "webflow",
  "wix",
  "x",
  "youtube",
] as const satisfies readonly ConnectorType[];

const AI_GENERAL_MODEL_TYPES = [
  "openai",
  "deepseek",
  "groq",
  "hugging-face",
  "minimax",
  "together",
] as const satisfies readonly ConnectorType[];

const AI_IMAGE_VIDEO_TYPES = [
  "fal",
  "luma",
  "pika",
  "replicate",
  "runway",
  "stability-ai",
] as const satisfies readonly ConnectorType[];

const AI_VOICE_AUDIO_TYPES = [
  "elevenlabs",
  "hume",
] as const satisfies readonly ConnectorType[];

const AI_AGENT_APPS_TYPES = [
  "anthropic-managed-agents",
  "dify",
  "manus",
  "v0",
] as const satisfies readonly ConnectorType[];

const AI_MEMORY_TRACING_EVAL_TYPES = [
  "helicone",
  "langfuse",
  "langsmith",
  "mem0",
  "wandb",
  "zep",
] as const satisfies readonly ConnectorType[];

const DATA_AUTOMATION_INFRASTRUCTURE_TYPES = [
  "amplitude",
  "apify",
  "axiom",
  "brave-search",
  "bright-data",
  "browserbase",
  "browserless",
  "cronlytic",
  "db9",
  "docusign",
  "dropbox-sign",
  "duffel",
  "e2b",
  "etsy",
  "exa",
  "firecrawl",
  "garmin-connect",
  "jotform",
  "make",
  "metabase",
  "mixpanel",
  "n8n",
  "neon",
  "pandadoc",
  "pdf4me",
  "pdfco",
  "pdforge",
  "perplexity",
  "pinecone",
  "plausible",
  "podchaser",
  "posthog",
  "prisma-postgres",
  "qdrant",
  "reddit",
  "revenuecat",
  "scrapeninja",
  "serpapi",
  "shopify",
  "spotify",
  "strava",
  "stripe",
  "supabase",
  "supadata",
  "tavily",
  "test-oauth",
  "typeform",
  "xero",
  "zapier",
  "zapsign",
] as const satisfies readonly ConnectorType[];

interface ConnectorCategorySection<T> {
  category: ConnectorDisplayCategory;
  label: string;
  connectors: T[];
}

function getConnectorCategoryLabel(category: ConnectorDisplayCategory): string {
  switch (category) {
    case "ai-general-models": {
      return "AI: General Models and Reasoning";
    }
    case "ai-image-video": {
      return "AI: Image / Video Generation";
    }
    case "ai-voice-audio": {
      return "AI: Voice / Audio";
    }
    case "ai-agent-apps": {
      return "AI: Agent Platforms and AI Apps";
    }
    case "ai-memory-tracing-eval": {
      return "AI: Memory / Tracing / Evaluation";
    }
    case "communication-collaboration": {
      return "Communication and Collaboration";
    }
    case "meetings-scheduling": {
      return "Meetings and Scheduling";
    }
    case "docs-files-knowledge": {
      return "Docs, Files, and Knowledge";
    }
    case "engineering-team-execution": {
      return "Engineering and Team Execution";
    }
    case "sales-crm-business-operations": {
      return "Sales, CRM, and Business Operations";
    }
    case "marketing-content-growth": {
      return "Marketing, Content, and Growth";
    }
    case "data-automation-infrastructure": {
      return "Data, Automation, and Infrastructure";
    }
  }
}

function includesConnectorType(
  types: readonly ConnectorType[],
  type: ConnectorType,
): boolean {
  return types.includes(type);
}

export function getConnectorDisplayCategory(
  type: ConnectorType,
): ConnectorDisplayCategory {
  if (includesConnectorType(COMMUNICATION_COLLABORATION_TYPES, type)) {
    return "communication-collaboration";
  }
  if (includesConnectorType(MEETINGS_SCHEDULING_TYPES, type)) {
    return "meetings-scheduling";
  }
  if (includesConnectorType(DOCS_FILES_KNOWLEDGE_TYPES, type)) {
    return "docs-files-knowledge";
  }
  if (includesConnectorType(ENGINEERING_TEAM_EXECUTION_TYPES, type)) {
    return "engineering-team-execution";
  }
  if (includesConnectorType(SALES_CRM_BUSINESS_OPERATIONS_TYPES, type)) {
    return "sales-crm-business-operations";
  }
  if (includesConnectorType(MARKETING_CONTENT_GROWTH_TYPES, type)) {
    return "marketing-content-growth";
  }
  if (includesConnectorType(AI_GENERAL_MODEL_TYPES, type)) {
    return "ai-general-models";
  }
  if (includesConnectorType(AI_IMAGE_VIDEO_TYPES, type)) {
    return "ai-image-video";
  }
  if (includesConnectorType(AI_VOICE_AUDIO_TYPES, type)) {
    return "ai-voice-audio";
  }
  if (includesConnectorType(AI_AGENT_APPS_TYPES, type)) {
    return "ai-agent-apps";
  }
  if (includesConnectorType(AI_MEMORY_TRACING_EVAL_TYPES, type)) {
    return "ai-memory-tracing-eval";
  }
  if (includesConnectorType(DATA_AUTOMATION_INFRASTRUCTURE_TYPES, type)) {
    return "data-automation-infrastructure";
  }
  return "data-automation-infrastructure";
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
