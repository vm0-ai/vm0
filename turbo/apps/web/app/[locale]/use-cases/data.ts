// ---------------------------------------------------------------------------
// Use Cases – types & static data
// ---------------------------------------------------------------------------

export type Role =
  | "engineering"
  | "product"
  | "marketing"
  | "support"
  | "compliance"
  | "ops"
  | "everyone";
export type Capability = "multi-tool" | "scheduled" | "instant";

export interface ConnectorRef {
  id: string;
  label: string;
  icon: string;
  darkIcon?: string;
  /** true when the icon SVG is dark-coloured and needs inversion in dark mode */
  dark?: boolean;
  /** true when the icon SVG's artwork only fills a fraction of its viewBox
   *  (e.g. the official Slack Mark's 270×270 viewBox with artwork centred in
   *  ~45%). The renderer scales the <img> up to compensate. */
  looseViewBox?: boolean;
}

export interface IntegrationData {
  connector: ConnectorRef;
  required: boolean;
}

export interface AvatarConfig {
  rotation: number;
  skin: number;
  hairStyle: number;
  hairColor: number;
  expression: number;
  intensity: "d" | "m" | "h";
}

export interface UseCase {
  slug: string;
  color: string;
  avatar: AvatarConfig;
  roles: Role[];
  capability: Capability;
  model: string;
  videoId?: string;
  connectors: ConnectorRef[];
  integrations: IntegrationData[];
  relatedSlugs: string[];
  stepCount: number;
  nextActionCount: number;
  integrationCount: number;
  tipCount: number;
  promptVariantCount: number;
  slackPreviewCount: number;
}

// ---------------------------------------------------------------------------
// Connector refs (reusable across use cases)
// ---------------------------------------------------------------------------

const SLACK: ConnectorRef = {
  id: "slack",
  label: "Slack",
  icon: "/assets/mockup/slack.svg",
  looseViewBox: true,
};

const SENTRY: ConnectorRef = {
  id: "sentry",
  label: "Sentry",
  icon: "/assets/connectors/sentry.svg",
  dark: true,
};

const GITHUB: ConnectorRef = {
  id: "github",
  label: "GitHub",
  icon: "/assets/connectors/github.svg",
  dark: true,
};

const GMAIL: ConnectorRef = {
  id: "gmail",
  label: "Gmail",
  icon: "/assets/connectors/gmail.svg",
};

const GOOGLE_CALENDAR: ConnectorRef = {
  id: "google-calendar",
  label: "Calendar",
  icon: "/assets/connectors/google-calendar.svg",
};

const LINEAR: ConnectorRef = {
  id: "linear",
  label: "Linear",
  icon: "/assets/connectors/linear.svg",
};

const X_TWITTER: ConnectorRef = {
  id: "x",
  label: "X (Twitter)",
  icon: "/assets/connectors/x.svg",
  dark: true,
};

const NOTION: ConnectorRef = {
  id: "notion",
  label: "Notion",
  icon: "/assets/connectors/notion.svg",
  dark: true,
};

const AXIOM: ConnectorRef = {
  id: "axiom",
  label: "Axiom",
  icon: "/assets/connectors/axiom.svg",
  dark: true,
};

const V0: ConnectorRef = {
  id: "v0",
  label: "v0",
  icon: "/assets/connectors/v0.svg",
};

const VM0: ConnectorRef = {
  id: "vm0",
  label: "vm0",
  icon: "/assets/connectors/vm0.svg",
};

const ANTHROPIC_MANAGED_AGENTS: ConnectorRef = {
  id: "anthropic-managed-agents",
  label: "Anthropic Managed Agents",
  icon: "/assets/connectors/anthropic.svg",
  dark: true,
};

const RESEND: ConnectorRef = {
  id: "resend",
  label: "Resend",
  icon: "/assets/connectors/resend.svg",
  dark: true,
};

const STRAPI: ConnectorRef = {
  id: "strapi",
  label: "Strapi",
  icon: "/assets/connectors/strapi.svg",
};

const PLAUSIBLE: ConnectorRef = {
  id: "plausible",
  label: "Plausible",
  icon: "/assets/connectors/plausible.svg",
};

const GOOGLE_DRIVE: ConnectorRef = {
  id: "google-drive",
  label: "Google Drive",
  icon: "/assets/connectors/google-drive.svg",
};

const APOLLO: ConnectorRef = {
  id: "apollo",
  label: "Apollo",
  icon: "/assets/connectors/apollo.svg",
  dark: true,
};

const INSTANTLY: ConnectorRef = {
  id: "instantly",
  label: "Instantly",
  icon: "/assets/connectors/instantly.svg",
};

const FIGMA: ConnectorRef = {
  id: "figma",
  label: "Figma",
  icon: "/assets/connectors/figma.svg",
  dark: true,
};

const AHREFS: ConnectorRef = {
  id: "ahrefs",
  label: "Ahrefs",
  icon: "/assets/connectors/ahref.svg",
};

const FAL_AI: ConnectorRef = {
  id: "fal",
  label: "Fal.ai",
  icon: "/assets/connectors/fal.svg",
};

// ---------------------------------------------------------------------------
// Full use cases
// ---------------------------------------------------------------------------

export const USE_CASES: UseCase[] = [
  {
    slug: "auto-merge-releases",
    color: "#4fa68b",
    avatar: {
      rotation: 4,
      skin: 3,
      hairStyle: 2,
      hairColor: 1,
      expression: 1,
      intensity: "d",
    },
    roles: ["engineering", "ops"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB, SLACK],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: [
      "daily-engineering-brief",
      "error-triage-daily",
      "tech-debt-scan",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "sentry-triage",
    color: "#d4a96a",
    videoId: "iTYhvVp5z5k",
    avatar: {
      rotation: 1,
      skin: 1,
      hairStyle: 3,
      hairColor: 2,
      expression: 3,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, SENTRY, AXIOM, GITHUB],
    integrations: [
      { connector: SENTRY, required: true },
      { connector: GITHUB, required: false },
    ],
    relatedSlugs: [
      "file-bugs-from-slack",
      "kol-cold-outreach",
      "standup-summary",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "standup-summary",
    color: "#c89090",
    videoId: "0D7ScfH4fwk",
    avatar: {
      rotation: 2,
      skin: 3,
      hairStyle: 5,
      hairColor: 4,
      expression: 1,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "multi-tool",
    model: "GPT-4o",
    connectors: [GOOGLE_CALENDAR, GMAIL, LINEAR, NOTION],
    integrations: [
      { connector: GOOGLE_CALENDAR, required: true },
      { connector: GMAIL, required: true },
      { connector: LINEAR, required: true },
    ],
    relatedSlugs: [
      "sentry-triage",
      "kol-cold-outreach",
      "file-bugs-from-slack",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "kol-cold-outreach",
    color: "#c4a08a",
    videoId: "aignt_fZSVo",
    avatar: {
      rotation: 1,
      skin: 2,
      hairStyle: 1,
      hairColor: 1,
      expression: 3,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, GMAIL, NOTION, SLACK],
    integrations: [
      { connector: X_TWITTER, required: true },
      { connector: GMAIL, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: ["file-bugs-from-slack", "slack-triage", "standup-summary"],
    stepCount: 3,
    nextActionCount: 2,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "file-bugs-from-slack",
    color: "#c08050",
    videoId: "E08Bc02tDIM",
    avatar: {
      rotation: 4,
      skin: 4,
      hairStyle: 4,
      hairColor: 3,
      expression: 2,
      intensity: "h",
    },
    roles: ["engineering", "product"],
    capability: "instant",
    model: "GPT-4o mini",
    connectors: [SLACK, GITHUB, LINEAR],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: ["sentry-triage", "standup-summary", "kol-cold-outreach"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "slack-triage",
    color: "#7c9885",
    videoId: "XcqnMX1U0xY",
    avatar: {
      rotation: 3,
      skin: 2,
      hairStyle: 2,
      hairColor: 3,
      expression: 1,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, LINEAR, GOOGLE_CALENDAR],
    integrations: [
      { connector: SLACK, required: true },
      { connector: LINEAR, required: false },
      { connector: GOOGLE_CALENDAR, required: false },
    ],
    relatedSlugs: ["standup-summary", "file-bugs-from-slack", "sentry-triage"],
    stepCount: 3,
    nextActionCount: 2,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "employee-onboarding",
    color: "#6b8cae",
    videoId: "2YA7Iff4XHs",
    avatar: {
      rotation: 5,
      skin: 5,
      hairStyle: 2,
      hairColor: 5,
      expression: 5,
      intensity: "m",
    },
    roles: ["ops", "everyone"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, NOTION, GOOGLE_CALENDAR, GMAIL],
    integrations: [
      { connector: SLACK, required: true },
      { connector: NOTION, required: true },
      { connector: GOOGLE_CALENDAR, required: true },
      { connector: GMAIL, required: false },
    ],
    relatedSlugs: ["slack-triage", "standup-summary", "file-bugs-from-slack"],
    stepCount: 3,
    nextActionCount: 2,
    integrationCount: 4,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "build-with-v0",
    color: "#7c8cbe",
    avatar: {
      rotation: 3,
      skin: 1,
      hairStyle: 4,
      hairColor: 5,
      expression: 4,
      intensity: "h",
    },
    roles: ["engineering", "product"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, V0],
    integrations: [
      { connector: V0, required: true },
      { connector: SLACK, required: false },
    ],
    relatedSlugs: [
      "file-bugs-from-slack",
      "standup-summary",
      "employee-onboarding",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "document-decisions",
    color: "#8a7cbe",
    avatar: {
      rotation: 2,
      skin: 3,
      hairStyle: 3,
      hairColor: 1,
      expression: 2,
      intensity: "m",
    },
    roles: ["everyone", "ops"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: NOTION, required: true },
    ],
    relatedSlugs: ["standup-summary", "employee-onboarding", "slack-triage"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "product-health-briefing",
    color: "#6b9e8c",
    avatar: {
      rotation: 5,
      skin: 1,
      hairStyle: 5,
      hairColor: 3,
      expression: 3,
      intensity: "h",
    },
    roles: ["product", "engineering"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GOOGLE_CALENDAR, LINEAR, GITHUB],
    integrations: [
      { connector: SLACK, required: true },
      { connector: LINEAR, required: true },
      { connector: GITHUB, required: true },
      { connector: GOOGLE_CALENDAR, required: false },
    ],
    relatedSlugs: ["standup-summary", "sentry-triage", "document-decisions"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 4,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "tech-debt-scan",
    color: "#7c9ebe",
    avatar: {
      rotation: 4,
      skin: 2,
      hairStyle: 1,
      hairColor: 5,
      expression: 1,
      intensity: "m",
    },
    roles: ["engineering"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB],
    integrations: [{ connector: GITHUB, required: true }],
    relatedSlugs: ["sentry-triage", "file-bugs-from-slack", "pr-review"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 1,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "competitor-audit",
    color: "#be7c9a",
    avatar: {
      rotation: 3,
      skin: 5,
      hairStyle: 4,
      hairColor: 2,
      expression: 5,
      intensity: "h",
    },
    roles: ["marketing", "product"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, NOTION, SLACK],
    integrations: [
      { connector: X_TWITTER, required: true },
      { connector: NOTION, required: true },
      { connector: SLACK, required: false },
    ],
    relatedSlugs: [
      "kol-cold-outreach",
      "document-decisions",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "daily-engineering-brief",
    color: "#7c9ebe",
    avatar: {
      rotation: 2,
      skin: 4,
      hairStyle: 5,
      hairColor: 2,
      expression: 3,
      intensity: "h",
    },
    roles: ["engineering", "product"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB, LINEAR, SENTRY, PLAUSIBLE],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
      { connector: LINEAR, required: false },
      { connector: SENTRY, required: false },
      { connector: PLAUSIBLE, required: false },
    ],
    relatedSlugs: [
      "product-health-briefing",
      "sentry-triage",
      "error-triage-daily",
    ],
    stepCount: 4,
    nextActionCount: 3,
    integrationCount: 5,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "competitor-pricing-monitor",
    color: "#7cbeab",
    avatar: {
      rotation: 5,
      skin: 2,
      hairStyle: 4,
      hairColor: 1,
      expression: 4,
      intensity: "d",
    },
    roles: ["marketing", "product"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [NOTION, SLACK],
    integrations: [
      { connector: NOTION, required: true },
      { connector: SLACK, required: false },
    ],
    relatedSlugs: [
      "competitor-audit",
      "kol-cold-outreach",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "customer-360",
    color: "#9e8abe",
    avatar: {
      rotation: 1,
      skin: 5,
      hairStyle: 5,
      hairColor: 1,
      expression: 1,
      intensity: "d",
    },
    roles: ["support"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [GMAIL, GOOGLE_CALENDAR, SLACK, LINEAR, GITHUB],
    integrations: [
      { connector: GMAIL, required: true },
      { connector: GOOGLE_CALENDAR, required: true },
      { connector: SLACK, required: true },
      { connector: LINEAR, required: false },
      { connector: GITHUB, required: false },
    ],
    relatedSlugs: [
      "standup-summary",
      "kol-cold-outreach",
      "document-decisions",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 5,
    tipCount: 3,
    promptVariantCount: 4,
    slackPreviewCount: 2,
  },

  {
    slug: "trending-topic-radar",
    color: "#be9a5c",
    avatar: {
      rotation: 5,
      skin: 3,
      hairStyle: 1,
      hairColor: 4,
      expression: 5,
      intensity: "h",
    },
    roles: ["marketing"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, SLACK, NOTION],
    integrations: [
      { connector: X_TWITTER, required: true },
      { connector: SLACK, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "competitor-audit",
      "document-decisions",
      "content-performance-report",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 4,
    slackPreviewCount: 2,
  },

  {
    slug: "content-performance-report",
    color: "#7cbe9e",
    avatar: {
      rotation: 2,
      skin: 4,
      hairStyle: 4,
      hairColor: 2,
      expression: 3,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, SLACK, NOTION, PLAUSIBLE],
    integrations: [
      { connector: X_TWITTER, required: true },
      { connector: SLACK, required: true },
      { connector: NOTION, required: true },
      { connector: PLAUSIBLE, required: false },
    ],
    relatedSlugs: [
      "competitor-audit",
      "trending-topic-radar",
      "kol-cold-outreach",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 4,
    tipCount: 3,
    promptVariantCount: 4,
    slackPreviewCount: 2,
  },

  {
    slug: "error-triage-daily",
    color: "#9abe7c",
    avatar: {
      rotation: 2,
      skin: 1,
      hairStyle: 3,
      hairColor: 3,
      expression: 2,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SENTRY, AXIOM, GITHUB],
    integrations: [
      { connector: SENTRY, required: true },
      { connector: GITHUB, required: true },
      { connector: AXIOM, required: false },
    ],
    relatedSlugs: [
      "sentry-triage",
      "tech-debt-scan",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "marketing-emails",
    color: "#d68c7c",
    avatar: {
      rotation: 4,
      skin: 3,
      hairStyle: 5,
      hairColor: 2,
      expression: 4,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, RESEND, NOTION, LINEAR],
    integrations: [
      { connector: RESEND, required: true },
      { connector: SLACK, required: true },
      { connector: NOTION, required: false },
      { connector: LINEAR, required: false },
    ],
    relatedSlugs: [
      "kol-cold-outreach",
      "standup-summary",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 4,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "multilingual-cms-publishing",
    color: "#8E75FF",
    avatar: {
      rotation: 2,
      skin: 2,
      hairStyle: 3,
      hairColor: 1,
      expression: 3,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, STRAPI, NOTION],
    integrations: [
      { connector: STRAPI, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "kol-cold-outreach",
      "document-decisions",
      "competitor-audit",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "kb-ingest",
    color: "#a07abe",
    avatar: {
      rotation: 2,
      skin: 3,
      hairStyle: 1,
      hairColor: 4,
      expression: 3,
      intensity: "m",
    },
    roles: ["support"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB],
    integrations: [
      { connector: SLACK, required: true },
      { connector: GITHUB, required: false },
    ],
    relatedSlugs: ["document-decisions", "competitor-audit", "standup-summary"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "pr-review",
    color: "#5a8a7a",
    avatar: {
      rotation: 4,
      skin: 1,
      hairStyle: 5,
      hairColor: 2,
      expression: 4,
      intensity: "h",
    },
    roles: ["engineering"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: false },
    ],
    relatedSlugs: ["file-bugs-from-slack", "tech-debt-scan", "sentry-triage"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "api-performance",
    color: "#c07890",
    avatar: {
      rotation: 1,
      skin: 4,
      hairStyle: 3,
      hairColor: 1,
      expression: 2,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, AXIOM, GITHUB],
    integrations: [
      { connector: AXIOM, required: true },
      { connector: GITHUB, required: false },
    ],
    relatedSlugs: [
      "sentry-triage",
      "error-triage-daily",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "marketing-analytics",
    color: "#7cbe9a",
    avatar: {
      rotation: 3,
      skin: 2,
      hairStyle: 2,
      hairColor: 5,
      expression: 5,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, PLAUSIBLE, NOTION],
    integrations: [
      { connector: PLAUSIBLE, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "competitor-audit",
      "content-performance-report",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "production-db-query",
    color: "#be8a5a",
    avatar: {
      rotation: 5,
      skin: 5,
      hairStyle: 4,
      hairColor: 3,
      expression: 1,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, VM0],
    integrations: [
      { connector: VM0, required: true },
      { connector: SLACK, required: false },
    ],
    relatedSlugs: ["sentry-triage", "api-performance", "error-triage-daily"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "security-compliance",
    color: "#be7c5a",
    avatar: {
      rotation: 5,
      skin: 1,
      hairStyle: 4,
      hairColor: 3,
      expression: 1,
      intensity: "m",
    },
    roles: ["compliance", "engineering"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB, NOTION],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "tech-debt-scan",
      "document-decisions",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "daily-email-triage",
    color: "#be8a5c",
    avatar: {
      rotation: 1,
      skin: 2,
      hairStyle: 3,
      hairColor: 4,
      expression: 2,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GMAIL, SLACK],
    integrations: [
      { connector: GMAIL, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: ["slack-triage", "standup-summary", "document-decisions"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "auto-test-coverage",
    color: "#5abe7c",
    avatar: {
      rotation: 3,
      skin: 1,
      hairStyle: 5,
      hairColor: 2,
      expression: 4,
      intensity: "h",
    },
    roles: ["engineering"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB, LINEAR, SLACK],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
      { connector: LINEAR, required: false },
    ],
    relatedSlugs: ["tech-debt-scan", "pr-review", "error-triage-daily"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "daily-user-analysis",
    color: "#5a8abe",
    avatar: {
      rotation: 5,
      skin: 4,
      hairStyle: 2,
      hairColor: 3,
      expression: 1,
      intensity: "d",
    },
    roles: ["product", "engineering"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, VM0],
    integrations: [
      { connector: VM0, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: [
      "product-health-briefing",
      "production-db-query",
      "marketing-analytics",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "evening-brief",
    color: "#9a7c5a",
    avatar: {
      rotation: 2,
      skin: 3,
      hairStyle: 1,
      hairColor: 5,
      expression: 3,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB],
    integrations: [
      { connector: SLACK, required: true },
      { connector: GITHUB, required: true },
    ],
    relatedSlugs: [
      "standup-summary",
      "product-health-briefing",
      "daily-engineering-brief",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "cost-optimizer",
    color: "#8a5abe",
    avatar: {
      rotation: 4,
      skin: 5,
      hairStyle: 4,
      hairColor: 1,
      expression: 5,
      intensity: "h",
    },
    roles: ["engineering", "ops"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, VM0],
    integrations: [
      { connector: VM0, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: [
      "auto-merge-releases",
      "production-db-query",
      "tech-debt-scan",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "merge-queue-monitor",
    color: "#5a9abe",
    avatar: {
      rotation: 1,
      skin: 2,
      hairStyle: 4,
      hairColor: 3,
      expression: 2,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB, SLACK],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: ["auto-merge-releases", "pr-review", "tech-debt-scan"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "investor-board-updates",
    color: "#3e7abe",
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 2,
      hairColor: 1,
      expression: 4,
      intensity: "d",
    },
    roles: ["product", "ops"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [LINEAR, GITHUB, PLAUSIBLE, GMAIL, NOTION],
    integrations: [
      { connector: LINEAR, required: true },
      { connector: GITHUB, required: true },
      { connector: PLAUSIBLE, required: true },
      { connector: GMAIL, required: false },
      { connector: NOTION, required: true },
    ],
    relatedSlugs: [
      "product-health-briefing",
      "marketing-analytics",
      "customer-360",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 5,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "lead-followups",
    color: "#be5a4f",
    avatar: {
      rotation: 1,
      skin: 3,
      hairStyle: 5,
      hairColor: 2,
      expression: 3,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [GMAIL, NOTION],
    integrations: [
      { connector: GMAIL, required: true },
      { connector: NOTION, required: true },
    ],
    relatedSlugs: ["kol-cold-outreach", "marketing-emails", "customer-360"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "release-notes-generator",
    color: "#5abe8e",
    avatar: {
      rotation: 4,
      skin: 2,
      hairStyle: 1,
      hairColor: 5,
      expression: 2,
      intensity: "d",
    },
    roles: ["engineering", "marketing"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB, SLACK],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: [
      "auto-merge-releases",
      "release-readiness-check",
      "standup-summary",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "meeting-action-items",
    color: "#be9a3a",
    avatar: {
      rotation: 5,
      skin: 1,
      hairStyle: 4,
      hairColor: 3,
      expression: 5,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [GOOGLE_CALENDAR, SLACK, NOTION],
    integrations: [
      { connector: GOOGLE_CALENDAR, required: true },
      { connector: SLACK, required: true },
      { connector: NOTION, required: true },
    ],
    relatedSlugs: ["standup-summary", "document-decisions", "morning-brief"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "promo-video-from-recordings",
    color: "#c86478",
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 1,
      hairColor: 3,
      expression: 5,
      intensity: "m",
    },
    roles: ["product", "ops"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GOOGLE_DRIVE, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: GOOGLE_DRIVE, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "marketing-content-automation",
      "competitor-audit",
      "multilingual-cms-publishing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "cross-tool-context",
    color: "#7abebe",
    avatar: {
      rotation: 2,
      skin: 5,
      hairStyle: 3,
      hairColor: 2,
      expression: 3,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, NOTION, LINEAR, GITHUB],
    integrations: [
      { connector: SLACK, required: true },
      { connector: LINEAR, required: true },
      { connector: NOTION, required: false },
      { connector: GITHUB, required: false },
    ],
    relatedSlugs: [
      "standup-summary",
      "document-decisions",
      "product-health-briefing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 4,
    tipCount: 3,
    promptVariantCount: 4,
    slackPreviewCount: 2,
  },

  {
    slug: "voice-driven-agent",
    color: "#6b7fbf",
    avatar: {
      rotation: 1,
      skin: 2,
      hairStyle: 4,
      hairColor: 3,
      expression: 5,
      intensity: "m",
    },
    roles: ["engineering"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, ANTHROPIC_MANAGED_AGENTS, GITHUB],
    integrations: [
      { connector: SLACK, required: true },
      { connector: ANTHROPIC_MANAGED_AGENTS, required: true },
      { connector: GITHUB, required: false },
    ],
    relatedSlugs: [
      "daily-engineering-brief",
      "build-with-v0",
      "file-bugs-from-slack",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "developer-support-triage",
    color: "#8abe9a",
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 1,
      hairColor: 2,
      expression: 3,
      intensity: "m",
    },
    roles: ["support", "engineering"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB, GMAIL],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
      { connector: GMAIL, required: false },
    ],
    relatedSlugs: ["file-bugs-from-slack", "customer-360", "slack-triage"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "morning-brief",
    color: "#d4a06b",
    avatar: {
      rotation: 5,
      skin: 1,
      hairStyle: 3,
      hairColor: 5,
      expression: 1,
      intensity: "d",
    },
    roles: ["everyone"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GOOGLE_CALENDAR, LINEAR, SLACK, X_TWITTER, GITHUB],
    integrations: [
      { connector: GOOGLE_CALENDAR, required: true },
      { connector: LINEAR, required: true },
      { connector: SLACK, required: true },
      { connector: X_TWITTER, required: false },
      { connector: GITHUB, required: false },
    ],
    relatedSlugs: [
      "standup-summary",
      "evening-brief",
      "daily-engineering-brief",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 5,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "gmail-poll-dm",
    color: "#b88cbe",
    avatar: {
      rotation: 2,
      skin: 5,
      hairStyle: 4,
      hairColor: 1,
      expression: 4,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GMAIL, SLACK],
    integrations: [
      { connector: GMAIL, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: ["daily-email-triage", "slack-triage", "morning-brief"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "release-readiness-check",
    color: "#6bbe9a",
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 3,
      hairColor: 4,
      expression: 4,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB, SLACK],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: ["auto-merge-releases", "merge-queue-monitor", "pr-review"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "docs-auto-update",
    color: "#c28a9e",
    avatar: {
      rotation: 5,
      skin: 2,
      hairStyle: 1,
      hairColor: 3,
      expression: 5,
      intensity: "m",
    },
    roles: ["support", "marketing"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: GITHUB, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: ["kb-ingest", "customer-360", "document-decisions"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "control-verification",
    color: "#5a7cbe",
    avatar: {
      rotation: 1,
      skin: 5,
      hairStyle: 2,
      hairColor: 5,
      expression: 1,
      intensity: "d",
    },
    roles: ["compliance"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB, NOTION],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: NOTION, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: [
      "security-compliance",
      "tech-debt-scan",
      "document-decisions",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "brief-to-draft-content",
    color: "#8ebe5a",
    avatar: {
      rotation: 4,
      skin: 3,
      hairStyle: 5,
      hairColor: 1,
      expression: 3,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, STRAPI, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: STRAPI, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "multilingual-cms-publishing",
      "content-experiment-engine",
      "marketing-emails",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "cover-art-generation",
    color: "#be7c3a",
    avatar: {
      rotation: 3,
      skin: 5,
      hairStyle: 3,
      hairColor: 4,
      expression: 5,
      intensity: "h",
    },
    roles: ["marketing"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, FIGMA, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: FIGMA, required: false },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "brief-to-draft-content",
      "content-experiment-engine",
      "multilingual-cms-publishing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "content-experiment-engine",
    color: "#5abeab",
    avatar: {
      rotation: 1,
      skin: 4,
      hairStyle: 1,
      hairColor: 5,
      expression: 2,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, NOTION, SLACK],
    integrations: [
      { connector: X_TWITTER, required: true },
      { connector: NOTION, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: [
      "content-performance-report",
      "competitor-audit",
      "trending-topic-radar",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "agent-video-production",
    color: "#ab5abe",
    avatar: {
      rotation: 5,
      skin: 2,
      hairStyle: 4,
      hairColor: 1,
      expression: 4,
      intensity: "h",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, ANTHROPIC_MANAGED_AGENTS, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: ANTHROPIC_MANAGED_AGENTS, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "brief-to-draft-content",
      "cover-art-generation",
      "content-experiment-engine",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "seo-blog-writing",
    color: "#c47a9e",
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 1,
      hairColor: 3,
      expression: 3,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [AHREFS, STRAPI, FAL_AI],
    integrations: [
      { connector: AHREFS, required: true },
      { connector: STRAPI, required: true },
      { connector: FAL_AI, required: false },
    ],
    relatedSlugs: [
      "multilingual-cms-publishing",
      "content-performance-report",
      "content-experiment-engine",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "cold-outreach-pipeline",
    color: "#d07a5c",
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 1,
      hairColor: 3,
      expression: 5,
      intensity: "h",
    },
    roles: ["ops"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [APOLLO, INSTANTLY, SLACK],
    integrations: [
      { connector: APOLLO, required: true },
      { connector: INSTANTLY, required: true },
      { connector: SLACK, required: false },
    ],
    relatedSlugs: ["kol-cold-outreach", "competitor-audit", "marketing-emails"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 3,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getUseCaseBySlug(slug: string): UseCase | undefined {
  return USE_CASES.find((uc) => {
    return uc.slug === slug;
  });
}

/**
 * Build a platform deep-link from an arbitrary prompt string and connector list.
 * Strips a leading `@Zero ` prefix from the prompt if present.
 */
export function buildPromptHref(
  prompt: string,
  connectors: ConnectorRef[],
  platformUrl: string,
): string {
  const cleaned = prompt.replace(/^@Zero\s+/i, "");
  const connector = connectors
    .map((c) => {
      return c.id;
    })
    .join(",");
  const qs = new URLSearchParams();
  if (cleaned) qs.set("prompt", cleaned);
  if (connector) qs.set("connector", connector);
  const query = qs.toString();
  return query ? `${platformUrl}/?${query}` : platformUrl;
}
