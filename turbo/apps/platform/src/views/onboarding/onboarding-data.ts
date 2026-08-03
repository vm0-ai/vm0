import { WORKFLOW_TEMPLATE_ITEMS, type WorkflowTemplateItem } from "@vm0/core";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { TFunction } from "i18next";
import type { OnboardingChoice } from "../../signals/onboarding/onboarding-state.ts";

interface OnboardingMakeOption {
  readonly id: OnboardingChoice;
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
}

const ONBOARDING_MAKE_OPTION_IDS = [
  "workflow",
  "presentation",
  "video",
  "images",
  "explore",
] as const satisfies readonly OnboardingChoice[];

const ONBOARDING_MAKE_OPTION_IMAGES: Readonly<
  Record<OnboardingChoice, string>
> = {
  workflow:
    "https://static.vm0.io/web/assets/onboarding/v2-choice-workflow-default_80x80.png",
  presentation:
    "https://static.vm0.io/web/assets/onboarding/v2-choice-presentation_80x80.png",
  video:
    "https://static.vm0.io/web/assets/onboarding/v2-choice-video_80x80.png",
  images:
    "https://static.vm0.io/web/assets/onboarding/v2-choice-images_80x80.png",
  explore:
    "https://static.vm0.io/web/assets/onboarding/v2-choice-explore_80x80.png",
};

export function onboardingMakeOptions(
  t: TFunction<"common">,
): readonly OnboardingMakeOption[] {
  return ONBOARDING_MAKE_OPTION_IDS.map((id) => {
    return {
      id,
      title: t(($) => {
        return $.onboarding.make.options[id].title;
      }),
      description: t(($) => {
        return $.onboarding.make.options[id].description;
      }),
      imageUrl: ONBOARDING_MAKE_OPTION_IMAGES[id],
    };
  });
}

export type OnboardingWorkflowCategoryId =
  | "engineering"
  | "product"
  | "data"
  | "marketing"
  | "sales"
  | "support"
  | "ceo"
  | "operations"
  | "everyone";

export interface OnboardingWorkflow {
  readonly id: OnboardingWorkflowId;
  readonly categoryId: OnboardingWorkflowCategoryId;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly requiredConnectorSlugs: readonly ConnectorSlug[];
  readonly scenario: string;
  readonly detailSteps: readonly { title: string; description: string }[];
}

export interface OnboardingWorkflowCategory {
  readonly id: OnboardingWorkflowCategoryId;
  readonly title: string;
  readonly description: string;
  readonly workflows: readonly OnboardingWorkflow[];
}

interface WorkflowPromptTemplate {
  readonly id: WorkflowTemplateItem["id"];
  readonly promptGuidance: string;
  readonly connectorSlugs: readonly ConnectorSlug[];
}

interface SupplementalWorkflowTemplate extends WorkflowPromptTemplate {
  readonly id: `workflow-template:${string}`;
}

function supplementalWorkflowTemplate(input: {
  readonly id: string;
  readonly prompt: string;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly requiredConnectorSlugs: readonly ConnectorSlug[];
}): SupplementalWorkflowTemplate {
  const optionalConnectorSlugs = input.connectorSlugs.filter(
    (connectorSlug) => {
      return !input.requiredConnectorSlugs.includes(connectorSlug);
    },
  );
  const connectorLine =
    optionalConnectorSlugs.length > 0
      ? `Connectors: ${input.requiredConnectorSlugs.join(", ")} required; ${optionalConnectorSlugs.join(", ")} optional.`
      : `Connectors: ${input.requiredConnectorSlugs.join(", ")} required.`;
  return {
    id: `workflow-template:${input.id}`,
    connectorSlugs: input.connectorSlugs,
    promptGuidance: `${input.prompt}\n\n${connectorLine} Connect any missing required connectors before running.`,
  };
}

const SUPPLEMENTAL_WORKFLOW_TEMPLATES: readonly SupplementalWorkflowTemplate[] =
  [
    supplementalWorkflowTemplate({
      id: "watch-sentry-after-release",
      prompt:
        "@Zero compare the latest release's crash-free rate in Sentry against the previous baseline and tell #dev whether it regressed, with a rollback suggestion if it did.",
      connectorSlugs: ["sentry", "github", "vercel", "slack"],
      requiredConnectorSlugs: ["sentry", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "post-github-updates-slack",
      prompt:
        "@Zero compile my merged and in-progress work from GitHub and Linear into a short progress update and post it to Slack.",
      connectorSlugs: ["github", "linear", "sentry", "slack"],
      requiredConnectorSlugs: ["github", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "report-ai-model-costs-slack",
      prompt:
        "@Zero report today's LLM token spend and p95 latency per model and route from Langfuse and post it to Slack.",
      connectorSlugs: ["langfuse", "slack"],
      requiredConnectorSlugs: ["langfuse", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "summarize-user-feedback-notion",
      prompt:
        "@Zero gather recent user feedback from Productlane, Typeform, Intercom, and GitHub, cluster it into themes, and write a ranked summary in Notion.",
      connectorSlugs: [
        "productlane",
        "typeform",
        "intercom",
        "github",
        "notion",
      ],
      requiredConnectorSlugs: ["notion"],
    }),
    supplementalWorkflowTemplate({
      id: "watch-brand-mentions",
      prompt:
        "@Zero search the web, Hacker News, and X for recent mentions of our product and post them to Slack.",
      connectorSlugs: ["exa", "x", "slack"],
      requiredConnectorSlugs: ["exa", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "sort-route-zendesk-tickets",
      prompt:
        "@Zero go through the new Zendesk tickets, set each one's severity, route it to the right team, and draft a first reply.",
      connectorSlugs: ["zendesk", "linear"],
      requiredConnectorSlugs: ["zendesk"],
    }),
    supplementalWorkflowTemplate({
      id: "fixes-to-notion-help-docs",
      prompt:
        "@Zero take a recently resolved ticket and turn the fix into a reusable help article in Notion.",
      connectorSlugs: ["notion", "zendesk"],
      requiredConnectorSlugs: ["notion", "zendesk"],
    }),
    supplementalWorkflowTemplate({
      id: "morning-brief-slack",
      prompt:
        "@Zero send me a brief with today's schedule and the emails that need me and post it to Slack.",
      connectorSlugs: ["gmail", "google-calendar", "slack"],
      requiredConnectorSlugs: ["gmail", "google-calendar", "slack"],
    }),
  ];

const WORKFLOW_IDS_BY_CATEGORY = {
  engineering: [
    "auto-merge-github-prs",
    "file-sentry-crashes-github",
    "watch-sentry-after-release",
    "post-github-updates-slack",
    "draft-github-release-notes-notion",
    "report-ai-model-costs-slack",
  ],
  product: [
    "github-idea-to-notion-spec",
    "summarize-user-feedback-notion",
    "post-release-notes-slack",
    "sync-linear-roadmap-notion",
    "track-feature-usage-posthog",
    "flag-figma-designs-no-task",
  ],
  data: [
    "post-daily-metrics-slack",
    "run-daily-query-sheets",
    "check-posthog-signup-funnel",
    "alert-metric-moves-slack",
    "track-signup-sources-sheets",
    "build-weekly-deck-gamma",
  ],
  marketing: [
    "track-keyword-ranks-ahrefs",
    "publish-scheduled-posts-buffer",
    "blog-posts-to-x",
    "draft-newsletter-mailchimp",
    "compare-google-ads-last-month",
    "watch-brand-mentions",
  ],
  sales: [
    "catch-leads-gmail",
    "new-gmail-contacts-hubspot",
    "research-new-signups-apollo",
    "gmail-followups-auto",
    "prep-google-calendar-meetings",
    "log-gong-calls-hubspot",
  ],
  support: [
    "sort-route-zendesk-tickets",
    "draft-replies-notion-faq",
    "send-bugs-github-slack",
    "fixes-to-notion-help-docs",
    "spot-churn-risk-stripe-zendesk",
    "summarize-zendesk-tickets-daily",
  ],
  ceo: [
    "daily-company-brief-slack",
    "daily-industry-news-slack",
    "business-review-gamma",
    "highlight-key-emails-gmail",
    "investor-update-google-docs",
    "gmail-reconnect-reminders",
  ],
  operations: [
    "sync-asana-projects-notion",
    "meeting-notes-asana-tasks",
    "file-gmail-invoices-drive",
    "onboard-new-hires-asana",
    "chase-overdue-asana-tasks",
    "catch-calendar-conflicts",
  ],
  everyone: [
    "sort-gmail-draft-replies",
    "morning-brief-slack",
    "research-calendar-meetings",
    "summarize-gmail-newsletters",
    "meeting-recaps-slack",
    "flagged-gmail-todoist-tasks",
  ],
} as const satisfies Readonly<
  Record<OnboardingWorkflowCategoryId, readonly string[]>
>;

export type OnboardingWorkflowId =
  (typeof WORKFLOW_IDS_BY_CATEGORY)[OnboardingWorkflowCategoryId][number];

const WORKFLOW_CATEGORY_IDS = [
  "engineering",
  "product",
  "data",
  "marketing",
  "sales",
  "support",
  "ceo",
  "operations",
  "everyone",
] as const satisfies readonly OnboardingWorkflowCategoryId[];

const WORKFLOW_STEP_KEYS = ["one", "two", "three"] as const;

const ALL_WORKFLOW_TEMPLATES: readonly WorkflowPromptTemplate[] = [
  ...WORKFLOW_TEMPLATE_ITEMS,
  ...SUPPLEMENTAL_WORKFLOW_TEMPLATES,
];

// Derives the required connectors from the "Connectors: X required; Y optional"
// line embedded in promptGuidance, so this stays the single source of truth with
// the guidance text. Templates without that line resolve to no required connectors.
function requiredConnectorSlugs(
  promptGuidance: string,
  connectorSlugs: readonly ConnectorSlug[],
): readonly ConnectorSlug[] {
  const match = promptGuidance.match(/Connectors:\s*([^.;\n]*?)\s+required/u);
  const captured = match?.[1];
  if (captured === undefined) {
    return [];
  }
  const declared = new Set(
    captured
      .split(",")
      .map((value) => {
        return value.trim();
      })
      .filter((value) => {
        return value.length > 0;
      }),
  );
  return connectorSlugs.filter((connectorSlug) => {
    return declared.has(connectorSlug);
  });
}

function onboardingWorkflow(
  id: OnboardingWorkflowId,
  categoryId: OnboardingWorkflowCategoryId,
  t: TFunction<"common">,
): OnboardingWorkflow {
  const template = ALL_WORKFLOW_TEMPLATES.find((candidate) => {
    return candidate.id === `workflow-template:${id}`;
  });
  if (!template) {
    throw new Error(`Missing onboarding workflow template: ${id}`);
  }
  return {
    id,
    categoryId,
    title: t(($) => {
      return $.onboarding.workflows[id].title;
    }),
    description: t(($) => {
      return $.onboarding.workflows[id].description;
    }),
    prompt: template.promptGuidance,
    connectorSlugs: template.connectorSlugs,
    requiredConnectorSlugs: requiredConnectorSlugs(
      template.promptGuidance,
      template.connectorSlugs,
    ),
    scenario: t(($) => {
      return $.onboarding.workflows[id].scenario;
    }),
    detailSteps: WORKFLOW_STEP_KEYS.map((stepKey) => {
      return {
        title: t(($) => {
          return $.onboarding.workflows[id].steps[stepKey].title;
        }),
        description: t(($) => {
          return $.onboarding.workflows[id].steps[stepKey].description;
        }),
      };
    }),
  };
}

export function onboardingWorkflowCategories(
  t: TFunction<"common">,
): readonly OnboardingWorkflowCategory[] {
  return WORKFLOW_CATEGORY_IDS.map((id) => {
    return {
      id,
      title: t(($) => {
        return $.onboarding.categories[id].title;
      }),
      description: t(($) => {
        return $.onboarding.categories[id].description;
      }),
      workflows: WORKFLOW_IDS_BY_CATEGORY[id].map((workflowId) => {
        return onboardingWorkflow(workflowId, id, t);
      }),
    };
  });
}

export const CUSTOM_WORKFLOW_ID = "talk-to-zero";

function onboardingWorkflowIdentity(workflowIdValue: string | null): {
  readonly id: OnboardingWorkflowId;
  readonly categoryId: OnboardingWorkflowCategoryId;
} | null {
  if (!workflowIdValue || workflowIdValue === CUSTOM_WORKFLOW_ID) {
    return null;
  }
  for (const categoryId of WORKFLOW_CATEGORY_IDS) {
    for (const id of WORKFLOW_IDS_BY_CATEGORY[categoryId]) {
      if (id === workflowIdValue) {
        return { id, categoryId };
      }
    }
  }
  return null;
}

export function hasOnboardingWorkflow(workflowIdValue: string | null): boolean {
  return onboardingWorkflowIdentity(workflowIdValue) !== null;
}

export function findOnboardingWorkflow(
  workflowIdValue: string | null,
  t: TFunction<"common">,
): OnboardingWorkflow | null {
  const identity = onboardingWorkflowIdentity(workflowIdValue);
  if (!identity) {
    return null;
  }
  return onboardingWorkflow(identity.id, identity.categoryId, t);
}

export function buildWorkflowPrompt(
  workflow: OnboardingWorkflow,
  note: string,
): string {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    return workflow.prompt;
  }
  return `${workflow.prompt}\n\nAdditional context:\n${trimmedNote}`;
}

export function buildCustomWorkflowPrompt(note: string): string {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    return "";
  }
  return trimmedNote.startsWith("@Zero") ? trimmedNote : `@Zero ${trimmedNote}`;
}

const VIDEO_PROMPTS: Readonly<Record<string, string>> = {
  "epic-grandeur":
    "/gen video with video template `epic-grandeur`, create a 12-second cinematic launch teaser for Aster Ridge, a mountain observatory opening at sunrise. Use sweeping aerial scale, golden backlight, slow camera movement, and a final title card.",
  "gourmet-documentary":
    "/gen video with video template `gourmet-documentary`, create a 12-second documentary spot for Hearth & Grain, an artisan bakery introducing its morning sourdough ritual. Focus on macro crust texture, steam, warm backlight, and hands at work.",
  "luxury-product":
    "/gen video with video template `luxury-product`, create a 10-second product reveal for a black ceramic chronograph watch. Use a dark studio, pinpoint highlights, premium material detail, slow macro movement, and a refined final lockup.",
  "shortform-viral":
    "/gen video with video template `shortform-viral`, create a 9:16 creator-style teaser for a desk setup upgrade. Start with a fast visual hook, use handheld energy, bright color, quick cuts, and end with a simple call to action.",
  "fashion-editorial":
    "/gen video with video template `fashion-editorial`, create a 12-second editorial film for a winter capsule collection in a concrete gallery. Use cold desaturated color, strong silhouettes, luxury fabric texture, and deliberate pose changes.",
  "sports-performance-ad":
    "/gen video with video template `sports-performance-ad`, create a 12-second performance ad for a carbon-plate running shoe. Show athlete effort, gear close-ups, impact rhythm, dramatic rim light, and a confident product end frame.",
  "japanese-wabi-sabi":
    "/gen video with video template `japanese-wabi-sabi`, create a 12-second quiet lifestyle film for a ceramic tea set in a morning kitchen. Use warm soft light, natural imperfection, negative space, and slow, calm motion.",
  "hand-drawn-fantasy-anime":
    "/gen video with video template `hand-drawn-fantasy-anime`, create a 12-second fantasy animation moment where a young mapmaker discovers a floating lantern forest. Use painterly 2D backgrounds, expressive character motion, and gentle wonder.",
  "cyberpunk-anime":
    "/gen video with video template `cyberpunk-anime`, create a 12-second 2D anime scene of a courier crossing a neon megacity at night. Use rain-slick streets, cel shading, glowing signage, and a melancholic final beat.",
  "chinese-ink-art":
    "/gen video with video template `chinese-ink-art`, create a 12-second ink-wash scene of cranes crossing misty mountains at dawn. Use monochrome brush texture, white space, drifting mist, and a calm classical-poetry mood.",
};

export function onboardingVideoPrompt(slug: string): string {
  const prompt = VIDEO_PROMPTS[slug];
  if (!prompt) {
    throw new Error(`Missing onboarding video prompt: ${slug}`);
  }
  return prompt;
}
