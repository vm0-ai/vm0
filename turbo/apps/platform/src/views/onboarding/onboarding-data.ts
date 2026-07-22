import { WORKFLOW_TEMPLATE_ITEMS, type WorkflowTemplateItem } from "@vm0/core";
import type { OnboardingChoice } from "../../signals/onboarding/onboarding-state.ts";

export interface OnboardingMakeOption {
  readonly id: OnboardingChoice;
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
}

export const ONBOARDING_MAKE_OPTIONS: readonly OnboardingMakeOption[] = [
  {
    id: "workflow",
    title: "Workflow automation",
    description: "Explore from preset templates",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-workflow-default_80x80.png",
  },
  {
    id: "presentation",
    title: "Generate a presentation",
    description: "Generate slides and speaker",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-presentation_80x80.png",
  },
  {
    id: "video",
    title: "Video production",
    description: "Turn your ideas into video",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-video_80x80.png",
  },
  {
    id: "images",
    title: "Generate images",
    description: "Create high-quality visuals",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-images_80x80.png",
  },
  {
    id: "explore",
    title: "I will explore on my own",
    description: "Just connect with my tools",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-explore_80x80.png",
  },
];

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
  readonly id: string;
  readonly categoryId: OnboardingWorkflowCategoryId;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly connectors: readonly string[];
  readonly steps: readonly string[];
}

export interface OnboardingWorkflowCategory {
  readonly id: OnboardingWorkflowCategoryId;
  readonly title: string;
  readonly description: string;
  readonly workflows: readonly OnboardingWorkflow[];
}

interface SupplementalWorkflowTemplate extends WorkflowTemplateItem {
  readonly id: `workflow-template:${string}`;
}

function supplementalWorkflowTemplate(input: {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly connectors: readonly string[];
}): SupplementalWorkflowTemplate {
  return {
    id: `workflow-template:${input.id}`,
    category: input.category,
    title: input.title,
    description: input.description,
    connectors: input.connectors,
    promptGuidance: input.prompt,
  };
}

const SUPPLEMENTAL_WORKFLOW_TEMPLATES: readonly SupplementalWorkflowTemplate[] =
  [
    supplementalWorkflowTemplate({
      id: "watch-sentry-after-release",
      category: "Engineering",
      title: "Watch Sentry after a release",
      description:
        "After each release Zero compares the new version's crash-free rate against baseline and flags a regression with a rollback suggestion.",
      prompt:
        "@Zero compare the latest release's crash-free rate in Sentry against the previous baseline and tell #dev whether it regressed, with a rollback suggestion if it did.",
      connectors: ["sentry", "github", "vercel", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "post-github-updates-slack",
      category: "Engineering",
      title: "Post GitHub updates to Slack",
      description:
        "Every weekday morning Zero compiles your merged and in-progress work from GitHub and Linear into a progress update for Slack.",
      prompt:
        "@Zero compile my merged and in-progress work from GitHub and Linear into a short progress update and post it to Slack.",
      connectors: ["github", "linear", "sentry", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "report-ai-model-costs-slack",
      category: "Engineering",
      title: "Report AI model costs to Slack",
      description:
        "Every day Zero reports LLM token spend and p95 latency per model and route from Langfuse to Slack.",
      prompt:
        "@Zero report today's LLM token spend and p95 latency per model and route from Langfuse and post it to Slack.",
      connectors: ["langfuse", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "summarize-user-feedback-notion",
      category: "Product",
      title: "Summarize user feedback in Notion",
      description:
        "Every week Zero gathers feedback from Productlane, Typeform, Intercom, and GitHub, clusters it into themes, and ranks it in Notion.",
      prompt:
        "@Zero gather recent user feedback from Productlane, Typeform, Intercom, and GitHub, cluster it into themes, and write a ranked summary in Notion.",
      connectors: ["productlane", "typeform", "intercom", "github", "notion"],
    }),
    supplementalWorkflowTemplate({
      id: "watch-brand-mentions",
      category: "Marketing",
      title: "Watch HN and X for brand mentions",
      description:
        "Every hour Zero searches the web, Hacker News, and X for mentions of your product and posts them to Slack.",
      prompt:
        "@Zero search the web, Hacker News, and X for recent mentions of our product and post them to Slack.",
      connectors: ["exa", "x", "slack"],
    }),
    supplementalWorkflowTemplate({
      id: "sort-route-zendesk-tickets",
      category: "Support",
      title: "Sort and route Zendesk tickets",
      description:
        "When a support ticket arrives, Zero sets its severity, routes it to the right team, and drafts a first reply.",
      prompt:
        "@Zero go through the new Zendesk tickets, set each one's severity, route it to the right team, and draft a first reply.",
      connectors: ["zendesk", "linear"],
    }),
    supplementalWorkflowTemplate({
      id: "fixes-to-notion-help-docs",
      category: "Support",
      title: "Turn fixes into Notion help docs",
      description:
        "When a ticket is marked resolved, Zero turns the fix into a reusable help article in Notion.",
      prompt:
        "@Zero take a recently resolved ticket and turn the fix into a reusable help article in Notion.",
      connectors: ["notion", "zendesk"],
    }),
    supplementalWorkflowTemplate({
      id: "morning-brief-slack",
      category: "Everyone",
      title: "Get a morning brief in Slack",
      description:
        "Every morning Zero sends a brief with your schedule and the emails that need you, and posts it to Slack.",
      prompt:
        "@Zero send me a brief with today's schedule and the emails that need me and post it to Slack.",
      connectors: ["gmail", "google-calendar", "slack"],
    }),
  ];

const WORKFLOW_IDS_BY_CATEGORY: Readonly<
  Record<OnboardingWorkflowCategoryId, readonly string[]>
> = {
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
};

const ALL_WORKFLOW_TEMPLATES: readonly WorkflowTemplateItem[] = [
  ...WORKFLOW_TEMPLATE_ITEMS,
  ...SUPPLEMENTAL_WORKFLOW_TEMPLATES,
];

const WORKFLOW_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  "track-keyword-ranks-ahrefs":
    "Every week Zero tracks target keyword rankings in Ahrefs and reports the movers in Notion.",
  "publish-scheduled-posts-buffer":
    "Every day Zero publishes the content scheduled for today from the Notion calendar to Strapi and queues the social posts in Buffer.",
  "blog-posts-to-x":
    "Every day Zero turns newly published blog posts into social variants and queues them to X through Buffer.",
  "draft-newsletter-mailchimp":
    "Every month Zero assembles a newsletter from shipped features and stages a draft in Mailchimp.",
  "compare-google-ads-last-month":
    "Every day Zero compares Google Ads and Meta Ads spend, CPA, and ROAS against the prior period and flags anomalies in Slack.",
};

function workflowSteps(promptGuidance: string): readonly string[] {
  return promptGuidance
    .split("\n")
    .filter((line) => {
      return line.startsWith("- ");
    })
    .map((line) => {
      return line.slice(2);
    })
    .slice(0, 4);
}

function onboardingWorkflow(
  id: string,
  categoryId: OnboardingWorkflowCategoryId,
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
    title: template.title,
    description: WORKFLOW_DESCRIPTION_OVERRIDES[id] ?? template.description,
    prompt: template.promptGuidance,
    connectors: template.connectors,
    steps: workflowSteps(template.promptGuidance),
  };
}

const WORKFLOW_CATEGORY_DETAILS: readonly Omit<
  OnboardingWorkflowCategory,
  "workflows"
>[] = [
  {
    id: "engineering",
    title: "Engineer",
    description: "Ship, debug, automate code",
  },
  { id: "product", title: "Product", description: "Specs, releases, feedback" },
  { id: "data", title: "Data", description: "Dashboards, metrics, queries" },
  {
    id: "marketing",
    title: "Marketing",
    description: "Content, SEO, campaigns",
  },
  { id: "sales", title: "Sales", description: "Pipeline and outreach" },
  {
    id: "support",
    title: "Support",
    description: "Tickets and customer help",
  },
  { id: "ceo", title: "CEO", description: "Briefings and the big picture" },
  {
    id: "operations",
    title: "Operations",
    description: "Projects, scheduling, sync",
  },
  {
    id: "everyone",
    title: "Everyone",
    description: "Email, calendar, meetings",
  },
];

export const ONBOARDING_WORKFLOW_CATEGORIES: readonly OnboardingWorkflowCategory[] =
  WORKFLOW_CATEGORY_DETAILS.map((category) => {
    return {
      ...category,
      workflows: WORKFLOW_IDS_BY_CATEGORY[category.id].map((id) => {
        return onboardingWorkflow(id, category.id);
      }),
    };
  });

export const CUSTOM_WORKFLOW_ID = "talk-to-zero";

export function findOnboardingWorkflow(
  workflowIdValue: string | null,
): OnboardingWorkflow | null {
  if (!workflowIdValue || workflowIdValue === CUSTOM_WORKFLOW_ID) {
    return null;
  }
  for (const category of ONBOARDING_WORKFLOW_CATEGORIES) {
    const workflow = category.workflows.find((candidate) => {
      return candidate.id === workflowIdValue;
    });
    if (workflow) {
      return workflow;
    }
  }
  return null;
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
