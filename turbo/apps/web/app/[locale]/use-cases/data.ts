// ---------------------------------------------------------------------------
// Use Cases – types & static data
// ---------------------------------------------------------------------------

export type Role =
  | "engineering"
  | "product"
  | "marketing"
  | "sales"
  | "support"
  | "compliance"
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
  screenshots?: string[];
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

const HEYGEN: ConnectorRef = {
  id: "heygen",
  label: "HeyGen",
  icon: "/assets/connectors/heygen.svg",
};

const ELEVENLABS: ConnectorRef = {
  id: "elevenlabs",
  label: "ElevenLabs",
  icon: "/assets/connectors/elevenlabs.svg",
  dark: true,
};

const GAMMA: ConnectorRef = {
  id: "gamma",
  label: "Gamma",
  icon: "/assets/connectors/gamma.svg",
};

// ---------------------------------------------------------------------------
// Full use cases
// ---------------------------------------------------------------------------

export const USE_CASES: UseCase[] = [
  {
    slug: "auto-merge-releases",
    color: "#4fa68b",
    screenshots: ["/assets/use-cases/auto-merge-releases.png"],
    avatar: {
      rotation: 4,
      skin: 3,
      hairStyle: 2,
      hairColor: 1,
      expression: 1,
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
    slug: "kol-cold-outreach",
    color: "#c4a08a",
    videoId: "aignt_fZSVo",
    screenshots: ["/assets/use-cases/kol-cold-outreach.png"],
    avatar: {
      rotation: 1,
      skin: 2,
      hairStyle: 1,
      hairColor: 1,
      expression: 3,
      intensity: "m",
    },
    roles: ["sales", "marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, GMAIL, NOTION, SLACK],
    integrations: [
      { connector: X_TWITTER, required: true },
      { connector: GMAIL, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: ["file-bugs-from-slack", "slack-triage", "morning-brief"],
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
    screenshots: ["/assets/use-cases/file-bugs-from-slack.png"],
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
    relatedSlugs: ["error-triage-daily", "morning-brief", "kol-cold-outreach"],
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
    screenshots: ["/assets/use-cases/slack-triage.png"],
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
    relatedSlugs: [
      "morning-brief",
      "file-bugs-from-slack",
      "error-triage-daily",
    ],
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
    screenshots: ["/assets/use-cases/employee-onboarding.png"],
    avatar: {
      rotation: 5,
      skin: 5,
      hairStyle: 2,
      hairColor: 5,
      expression: 5,
      intensity: "m",
    },
    roles: ["support", "everyone"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, NOTION, GOOGLE_CALENDAR, GMAIL],
    integrations: [
      { connector: SLACK, required: true },
      { connector: NOTION, required: true },
      { connector: GOOGLE_CALENDAR, required: true },
      { connector: GMAIL, required: false },
    ],
    relatedSlugs: ["slack-triage", "morning-brief", "file-bugs-from-slack"],
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
    screenshots: ["/assets/use-cases/build-with-v0.png"],
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
      "morning-brief",
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
    screenshots: [
      "/assets/use-cases/document-decisions.png",
      "/assets/use-cases/document-decisions-2.png",
    ],
    avatar: {
      rotation: 2,
      skin: 3,
      hairStyle: 3,
      hairColor: 1,
      expression: 2,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "scheduled",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: NOTION, required: true },
    ],
    relatedSlugs: ["morning-brief", "employee-onboarding", "slack-triage"],
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
    screenshots: ["/assets/use-cases/product-health-briefing.png"],
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
    relatedSlugs: ["morning-brief", "error-triage-daily", "document-decisions"],
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
    screenshots: ["/assets/use-cases/tech-debt-scan.png"],
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
    relatedSlugs: ["error-triage-daily", "file-bugs-from-slack", "pr-review"],
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
    screenshots: ["/assets/use-cases/competitor-audit.png"],
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
    screenshots: ["/assets/use-cases/daily-engineering-brief.png"],
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
      "auto-test-coverage",
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
    screenshots: ["/assets/use-cases/competitor-pricing-monitor.png"],
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
    screenshots: [
      "/assets/use-cases/customer-360.png",
      "/assets/use-cases/customer-360-2.png",
    ],
    avatar: {
      rotation: 1,
      skin: 5,
      hairStyle: 5,
      hairColor: 1,
      expression: 1,
      intensity: "d",
    },
    roles: ["sales"],
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
    relatedSlugs: ["morning-brief", "kol-cold-outreach", "document-decisions"],
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
    screenshots: ["/assets/use-cases/trending-topic-radar.png"],
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
    screenshots: ["/assets/use-cases/content-performance-report.png"],
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
    screenshots: ["/assets/use-cases/error-triage-daily.png"],
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
      "error-triage-daily",
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
    screenshots: ["/assets/use-cases/marketing-emails.png"],
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
      "morning-brief",
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
    screenshots: [
      "/assets/use-cases/multilingual-cms-publishing-2.png",
      "/assets/use-cases/multilingual-cms-publishing.png",
    ],
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
    slug: "pr-review",
    color: "#5a8a7a",
    screenshots: [
      "/assets/use-cases/pr-review.png",
      "/assets/use-cases/pr-review-2.png",
    ],
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
    relatedSlugs: [
      "file-bugs-from-slack",
      "tech-debt-scan",
      "error-triage-daily",
    ],
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
    screenshots: [
      "/assets/use-cases/api-performance.png",
      "/assets/use-cases/api-performance-2.png",
    ],
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
      "api-performance",
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
    screenshots: ["/assets/use-cases/marketing-analytics.png"],
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
    screenshots: [
      "/assets/use-cases/production-db-query.png",
      "/assets/use-cases/production-db-query-2.png",
    ],
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
    relatedSlugs: ["tech-debt-scan", "api-performance", "error-triage-daily"],
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
    screenshots: [
      "/assets/use-cases/security-compliance.png",
      "/assets/use-cases/security-compliance-2.png",
    ],
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
    screenshots: ["/assets/use-cases/daily-email-triage.png"],
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
    relatedSlugs: ["slack-triage", "morning-brief", "document-decisions"],
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
    screenshots: ["/assets/use-cases/auto-test-coverage.png"],
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
    screenshots: [
      "/assets/use-cases/daily-user-analysis.png",
      "/assets/use-cases/daily-user-analysis-2.png",
    ],
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
    slug: "cost-optimizer",
    color: "#8a5abe",
    screenshots: ["/assets/use-cases/cost-optimizer.png"],
    avatar: {
      rotation: 4,
      skin: 5,
      hairStyle: 4,
      hairColor: 1,
      expression: 5,
      intensity: "h",
    },
    roles: ["engineering"],
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
    screenshots: ["/assets/use-cases/merge-queue-monitor.png"],
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
    screenshots: ["/assets/use-cases/investor-board-updates.png"],
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 2,
      hairColor: 1,
      expression: 4,
      intensity: "d",
    },
    roles: ["product"],
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
    screenshots: ["/assets/use-cases/lead-followups.png"],
    avatar: {
      rotation: 1,
      skin: 3,
      hairStyle: 5,
      hairColor: 2,
      expression: 3,
      intensity: "m",
    },
    roles: ["sales"],
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
    screenshots: ["/assets/use-cases/release-notes-generator.png"],
    avatar: {
      rotation: 4,
      skin: 2,
      hairStyle: 1,
      hairColor: 5,
      expression: 2,
      intensity: "d",
    },
    roles: ["product", "engineering"],
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
      "morning-brief",
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
    screenshots: ["/assets/use-cases/meeting-action-items.png"],
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
    relatedSlugs: ["daily-email-triage", "document-decisions", "morning-brief"],
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
    screenshots: [
      "/assets/use-cases/promo-video-from-recordings.png",
      "/assets/use-cases/promo-video-from-recordings-2.png",
      "/assets/use-cases/promo-video-from-recordings-3.png",
    ],
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 1,
      hairColor: 3,
      expression: 5,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GOOGLE_DRIVE, ELEVENLABS, HEYGEN, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: GOOGLE_DRIVE, required: true },
      { connector: ELEVENLABS, required: true },
      { connector: HEYGEN, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: [
      "marketing-content-automation",
      "competitor-audit",
      "multilingual-cms-publishing",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 5,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "cross-tool-context",
    color: "#7abebe",
    screenshots: ["/assets/use-cases/cross-tool-context.png"],
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
      "morning-brief",
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
    screenshots: ["/assets/use-cases/voice-driven-agent.png"],
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
    screenshots: ["/assets/use-cases/developer-support-triage.png"],
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
    screenshots: [
      "/assets/use-cases/morning-brief.png",
      "/assets/use-cases/morning-brief-2.png",
    ],
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
    connectors: [GOOGLE_CALENDAR, LINEAR, SLACK, X_TWITTER, GITHUB, GAMMA],
    integrations: [
      { connector: GOOGLE_CALENDAR, required: true },
      { connector: LINEAR, required: true },
      { connector: SLACK, required: true },
      { connector: X_TWITTER, required: false },
      { connector: GITHUB, required: false },
      { connector: GAMMA, required: false },
    ],
    relatedSlugs: [
      "daily-email-triage",
      "daily-engineering-brief",
      "cross-tool-context",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 6,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "gmail-poll-dm",
    color: "#b88cbe",
    screenshots: ["/assets/use-cases/gmail-poll-dm.png"],
    avatar: {
      rotation: 2,
      skin: 5,
      hairStyle: 4,
      hairColor: 1,
      expression: 4,
      intensity: "m",
    },
    roles: ["sales", "everyone"],
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
    screenshots: ["/assets/use-cases/release-readiness-check.png"],
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
    screenshots: ["/assets/use-cases/docs-auto-update.png"],
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
    relatedSlugs: ["customer-360", "document-decisions"],
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
    screenshots: ["/assets/use-cases/control-verification.png"],
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
    screenshots: ["/assets/use-cases/brief-to-draft-content.png"],
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
      "content-performance-report",
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
    slug: "cold-outreach-pipeline",
    color: "#d07a5c",
    screenshots: ["/assets/use-cases/cold-outreach-pipeline.png"],
    avatar: {
      rotation: 3,
      skin: 4,
      hairStyle: 1,
      hairColor: 3,
      expression: 5,
      intensity: "h",
    },
    roles: ["sales"],
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

  {
    slug: "podcast-deep-research",
    color: "#5b6eab",
    screenshots: ["/assets/use-cases/podcast-deep-research.png"],
    avatar: {
      rotation: 0,
      skin: 5,
      hairStyle: 3,
      hairColor: 4,
      expression: 3,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, V0],
    integrations: [
      { connector: SLACK, required: true },
      { connector: V0, required: true },
    ],
    relatedSlugs: [
      "competitor-audit",
      "trending-topic-radar",
      "content-performance-report",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "summarize-shared-articles",
    color: "#5c9eb8",
    screenshots: ["/assets/use-cases/summarize-shared-articles.png"],
    avatar: {
      rotation: 2,
      skin: 3,
      hairStyle: 4,
      hairColor: 2,
      expression: 3,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, NOTION],
    integrations: [
      { connector: SLACK, required: true },
      { connector: NOTION, required: false },
    ],
    relatedSlugs: ["document-decisions", "slack-triage", "competitor-audit"],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "automate-blog-production",
    color: "#d4915e",
    avatar: {
      rotation: 2,
      skin: 2,
      hairStyle: 3,
      hairColor: 2,
      expression: 4,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "multi-tool",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, STRAPI],
    integrations: [
      { connector: SLACK, required: true },
      { connector: STRAPI, required: true },
    ],
    relatedSlugs: [
      "brief-to-draft-content",
      "multilingual-cms-publishing",
      "content-performance-report",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
    tipCount: 3,
    promptVariantCount: 3,
    slackPreviewCount: 2,
  },

  {
    slug: "publish-use-case-pages",
    color: "#b06e4a",
    screenshots: ["/assets/use-cases/publish-use-case-pages.png"],
    avatar: {
      rotation: 4,
      skin: 2,
      hairStyle: 3,
      hairColor: 4,
      expression: 4,
      intensity: "m",
    },
    roles: ["marketing"],
    capability: "instant",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, GITHUB],
    integrations: [
      { connector: GITHUB, required: true },
      { connector: SLACK, required: true },
    ],
    relatedSlugs: [
      "multilingual-cms-publishing",
      "brief-to-draft-content",
      "docs-auto-update",
    ],
    stepCount: 3,
    nextActionCount: 3,
    integrationCount: 2,
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
