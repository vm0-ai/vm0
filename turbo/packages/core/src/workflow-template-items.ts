export interface WorkflowTemplateItem {
  readonly id: `workflow-template:${string}`;
  readonly title: string;
  readonly description: string;
  // Persona group used to organize the template picker. One of
  // WORKFLOW_TEMPLATE_CATEGORIES.
  readonly category: string;
  readonly promptGuidance: string;
}

// Ordered persona groups for the template picker. "General" holds the generic
// starter template; the rest mirror the onboarding personas.
export const WORKFLOW_TEMPLATE_CATEGORIES: readonly string[] = [
  "General",
  "Engineering",
  "Product",
  "Data",
  "Marketing",
  "Sales",
  "Support",
  "CEO",
  "Operations",
  "Everyone",
];

// Structured source for the curated built-in workflow templates. Each spec is
// compiled into a WorkflowTemplateItem whose promptGuidance instructs the agent
// to build a workflow (via the workflow-setup skill) rather than run a one-shot
// prompt. The catalog mirrors the persona-bucketed onboarding cards in
// vm0-marketing (onboardingWorkflows.ts); it is duplicated here on purpose
// because the two repos serve different surfaces and must not import across.
interface WorkflowTemplateSpec {
  readonly slug: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  // The what: each line is one step of the workflow's behavior.
  readonly behavior: readonly string[];
  readonly requiredConnectors: readonly string[];
  readonly optionalConnectors: readonly string[];
  // The when/where: the trigger the agent should attach once the user confirms
  // the details. Only the event kinds the product supports are named; anything
  // without a native event falls back to a schedule, stated honestly.
  readonly suggestedTrigger: string;
}

function connectorLine(spec: WorkflowTemplateSpec): string {
  const parts: string[] = [];
  if (spec.requiredConnectors.length > 0) {
    parts.push(`${spec.requiredConnectors.join(", ")} required`);
  }
  if (spec.optionalConnectors.length > 0) {
    parts.push(`${spec.optionalConnectors.join(", ")} optional`);
  }
  return `Connectors: ${parts.join("; ")}.`;
}

function buildWorkflowTemplateItem(
  spec: WorkflowTemplateSpec,
): WorkflowTemplateItem {
  const id = `workflow-template:${spec.slug}` as const;
  return {
    id,
    title: spec.title,
    description: spec.description,
    category: spec.category,
    promptGuidance: [
      "# Workflow Template Context",
      "",
      `The user selected the built-in workflow template: ${spec.title} (${id}).`,
      "Use the workflow-setup skill to help the user create or remix a workflow for this agent.",
      "Do not execute an existing workflow. This template is only context for creating or updating a workflow.",
      "",
      "Template behavior:",
      ...spec.behavior.map((line) => {
        return `- ${line}`;
      }),
      "",
      connectorLine(spec),
      `Suggested trigger: ${spec.suggestedTrigger}`,
      "",
      "Before creating anything, confirm the trigger details, the destination (channel, doc, or sheet), and any labels, names, or thresholds referenced above, then connect any missing required connectors.",
    ].join("\n"),
  };
}

// Generic starter template, kept first and independent of any persona so a new
// user always has a minimal Gmail-label workflow to remix.
const AUTO_INBOX_LABEL: WorkflowTemplateItem = {
  id: "workflow-template:auto-inbox-label",
  title: "Auto-inbox label",
  description:
    "Create a workflow that runs when a Gmail label is applied and handles the labeled inbox item.",
  category: "General",
  promptGuidance: [
    "# Workflow Template Context",
    "",
    "The user selected the built-in workflow template: Auto-inbox label (workflow-template:auto-inbox-label).",
    "Use the workflow-setup skill to help the user create or remix a workflow for this agent.",
    "Do not execute an existing workflow. This template is only context for creating or updating a workflow.",
    "",
    "Template behavior:",
    "- Create a workflow that reacts when a named Gmail label is applied to a message.",
    "- Treat the labeled message as the inbox item to process.",
    "- Inspect the message context, decide the requested handling path, and prepare the appropriate follow-up.",
    "- Add a Gmail label-applied automation for the workflow once the user confirms the label name.",
    "",
    "Before creating anything, ask for the Gmail label name, handling rules, and final action if they are missing.",
  ].join("\n"),
};

const WORKFLOW_TEMPLATE_SPECS: readonly WorkflowTemplateSpec[] = [
  {
    slug: "auto-merge-github-prs",
    category: "Engineering",
    title: "Auto-merge GitHub PRs",
    description:
      "Zero reviews pull requests labeled ready-to-merge, waits for CI to pass, merges them, and reports the result to Slack.",
    behavior: [
      "A PR is labeled ready-to-merge",
      "Zero reviews and waits on CI",
      "Merged and posted to Slack",
    ],
    requiredConnectors: ["github"],
    optionalConnectors: ["vercel", "slack"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the ready-to-merge label so it runs the moment a PR is labeled.",
  },
  {
    slug: "file-sentry-crashes-github",
    category: "Engineering",
    title: "File Sentry crashes as GitHub issues",
    description:
      "Zero checks Sentry hourly, ranks new errors by user impact, files GitHub issues for the worst ones, and pings the owner.",
    behavior: [
      "Zero pulls new Sentry errors",
      "Ranked by user impact",
      "Issues filed and owner pinged",
    ],
    requiredConnectors: ["sentry", "github"],
    optionalConnectors: ["linear", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. hourly). Sentry has no native event trigger yet, so poll on a cadence.",
  },
  {
    slug: "watch-sentry-after-release",
    category: "Engineering",
    title: "Watch Sentry after a release",
    description:
      "After each release Zero compares the new version's crash-free rate against baseline and flags a regression with a rollback suggestion.",
    behavior: [
      "Zero watches the new release",
      "Compared against baseline",
      "Regression flagged with a rollback tip",
    ],
    requiredConnectors: ["sentry", "github"],
    optionalConnectors: ["vercel", "slack"],
    suggestedTrigger:
      "Add a schedule trigger that runs shortly after each release. Sentry has no native event trigger, so poll and compare against the prior baseline.",
  },
  {
    slug: "post-github-updates-slack",
    category: "Engineering",
    title: "Post GitHub updates to Slack",
    description:
      "Every weekday morning Zero compiles your merged and in-progress work from GitHub and Linear into a progress update for Slack.",
    behavior: [
      "Zero collects your activity",
      "Summarized into an update",
      "Posted to Slack",
    ],
    requiredConnectors: ["github"],
    optionalConnectors: ["linear", "sentry", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every weekday at end of day).",
  },
  {
    slug: "draft-github-release-notes-notion",
    category: "Engineering",
    title: "Draft GitHub release notes in Notion",
    description:
      "When a PR is labeled shipped, Zero turns the merged PRs since the last release into clean release notes in Notion.",
    behavior: [
      "A PR is labeled shipped",
      "Zero gathers merged PRs",
      "Release notes saved to Notion",
    ],
    requiredConnectors: ["github", "notion"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on a release label, or a schedule trigger you run per release.",
  },
  {
    slug: "report-ai-model-costs-slack",
    category: "Engineering",
    title: "Report AI model costs to Slack",
    description:
      "Every day Zero reports LLM token spend and p95 latency per model and route from Langfuse to Slack.",
    behavior: [
      "Zero reads Langfuse",
      "Broken down by model and route",
      "Posted to Slack",
    ],
    requiredConnectors: ["langfuse"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Langfuse has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "github-idea-to-notion-spec",
    category: "Product",
    title: "Turn a GitHub idea into a Notion spec",
    description:
      "When a GitHub issue is labeled needs-spec, Zero expands it into a structured PRD in Notion.",
    behavior: [
      "An issue is labeled needs-spec",
      "Zero expands it into a PRD",
      "Saved to Notion",
    ],
    requiredConnectors: ["github", "notion"],
    optionalConnectors: ["figma"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the needs-spec label.",
  },
  {
    slug: "summarize-user-feedback-notion",
    category: "Product",
    title: "Summarize user feedback in Notion",
    description:
      "Every week Zero gathers feedback from Productlane, Typeform, Intercom, and GitHub, clusters it into themes, and ranks it in Notion.",
    behavior: [
      "Zero pulls feedback",
      "Clustered into themes",
      "Summary saved to Notion",
    ],
    requiredConnectors: ["productlane", "notion"],
    optionalConnectors: ["typeform", "intercom", "github"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. weekly). These feedback sources have no native event trigger, so poll on a cadence.",
  },
  {
    slug: "post-release-notes-slack",
    category: "Product",
    title: "Post release notes to Slack",
    description:
      "When a PR is labeled release, Zero drafts a user-facing changelog and posts it to Slack and Notion.",
    behavior: [
      "A PR is labeled release",
      "Zero drafts the changelog",
      "Posted to Slack and Notion",
    ],
    requiredConnectors: ["github", "slack"],
    optionalConnectors: ["notion"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the release label.",
  },
  {
    slug: "sync-linear-roadmap-notion",
    category: "Product",
    title: "Sync the Linear roadmap to Notion",
    description:
      "Every day Zero syncs Linear ticket status into a Now / Next / Later roadmap board in Notion.",
    behavior: [
      "Zero reads Linear status",
      "Mapped to Now / Next / Later",
      "Board updated in Notion",
    ],
    requiredConnectors: ["linear", "notion"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Linear has no native event trigger here, so poll on a cadence.",
  },
  {
    slug: "track-feature-usage-posthog",
    category: "Product",
    title: "Track feature usage with PostHog",
    description:
      "Every week Zero checks PostHog for features rising or falling in usage and posts the shifts to Slack.",
    behavior: [
      "Zero reads PostHog",
      "Compared week over week",
      "Shifts posted to Slack",
    ],
    requiredConnectors: ["posthog"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. weekly). PostHog has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "flag-figma-designs-no-task",
    category: "Product",
    title: "Flag Figma designs without a task",
    description:
      "Every day Zero checks Figma for design frames that have no linked build task and flags them in Slack.",
    behavior: [
      "Zero scans Figma frames",
      "Finds frames without a task",
      "Gaps posted to Slack",
    ],
    requiredConnectors: ["figma"],
    optionalConnectors: ["linear", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Figma has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "post-daily-metrics-slack",
    category: "Data",
    title: "Post daily metrics to Slack",
    description:
      "Every morning Zero pulls visitors, signups, and activation from Plausible, PostHog, and Clerk and posts the KPIs to Slack.",
    behavior: [
      "Zero pulls the metrics",
      "Assembled into a KPI snapshot",
      "Posted to Slack",
    ],
    requiredConnectors: ["plausible", "slack"],
    optionalConnectors: ["posthog", "clerk"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "run-daily-query-sheets",
    category: "Data",
    title: "Run a daily query into Google Sheets",
    description:
      "Every day Zero runs your saved query and writes the formatted results into a Google Sheet.",
    behavior: [
      "Zero runs the query",
      "Results formatted",
      "Written to Google Sheets",
    ],
    requiredConnectors: ["snowflake", "google-sheets"],
    optionalConnectors: ["slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "check-posthog-signup-funnel",
    category: "Data",
    title: "Check the PostHog signup funnel",
    description:
      "Every week Zero runs the signup funnel in PostHog and posts the biggest drop-off to Slack.",
    behavior: [
      "Zero runs the funnel",
      "Biggest drop-off identified",
      "Posted to Slack",
    ],
    requiredConnectors: ["posthog"],
    optionalConnectors: ["slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "alert-metric-moves-slack",
    category: "Data",
    title: "Alert when a metric moves",
    description:
      "Every hour Zero watches a key metric and alerts Slack when it deviates from its normal range.",
    behavior: [
      "Zero checks the metric",
      "Compared to normal range",
      "Alert posted to Slack",
    ],
    requiredConnectors: ["plausible", "slack"],
    optionalConnectors: ["posthog"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. hourly) so anomalies surface quickly.",
  },
  {
    slug: "track-signup-sources-sheets",
    category: "Data",
    title: "Track signup sources in Google Sheets",
    description:
      "Every day Zero attributes new signups to their channel and campaign and appends them to a tracking Google Sheet.",
    behavior: [
      "Zero reads new signups",
      "Attributed to a channel",
      "Logged to Google Sheets",
    ],
    requiredConnectors: ["clerk", "google-sheets"],
    optionalConnectors: ["plausible"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Clerk has no native event trigger here, so poll on a cadence.",
  },
  {
    slug: "build-weekly-deck-gamma",
    category: "Data",
    title: "Build the weekly deck in Gamma",
    description:
      "Every week Zero assembles a metrics deck in Gamma from Sheets and analytics and posts it to Slack.",
    behavior: [
      "Zero gathers the numbers",
      "Deck built in Gamma",
      "Posted to Slack",
    ],
    requiredConnectors: ["google-sheets", "gamma"],
    optionalConnectors: ["plausible", "slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "track-keyword-ranks-ahrefs",
    category: "Marketing",
    title: "Track keyword ranks with Ahrefs",
    description:
      "Every week Zero tracks target keyword rankings in Ahrefs and reports the movers in Notion.",
    behavior: [
      "Zero reads keyword positions",
      "Movers identified",
      "Reported in Notion",
    ],
    requiredConnectors: ["ahrefs"],
    optionalConnectors: ["similarweb", "notion"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "publish-scheduled-posts-buffer",
    category: "Marketing",
    title: "Publish scheduled posts to Buffer",
    description:
      "Every day Zero publishes the content scheduled for today from the Notion calendar to Strapi and queues the social posts in Buffer.",
    behavior: [
      "Zero reads today's calendar",
      "Published to the CMS",
      "Social queued in Buffer",
    ],
    requiredConnectors: ["notion", "strapi"],
    optionalConnectors: ["buffer"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every morning) to publish the day's scheduled content.",
  },
  {
    slug: "blog-posts-to-x",
    category: "Marketing",
    title: "Turn blog posts into X posts",
    description:
      "Every day Zero turns newly published blog posts into social variants and queues them to X through Buffer.",
    behavior: [
      "Zero finds new posts",
      "Cut into social variants",
      "Queued in Buffer",
    ],
    requiredConnectors: ["strapi", "buffer"],
    optionalConnectors: ["x"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Publishing has no native event trigger, so poll for newly published posts.",
  },
  {
    slug: "draft-newsletter-mailchimp",
    category: "Marketing",
    title: "Draft the newsletter in Mailchimp",
    description:
      "Every month Zero assembles a newsletter from shipped features and stages a draft in Mailchimp.",
    behavior: [
      "Zero gathers what shipped",
      "Newsletter drafted",
      "Staged in Mailchimp",
    ],
    requiredConnectors: ["github", "mailchimp"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. monthly).",
  },
  {
    slug: "compare-google-ads-last-month",
    category: "Marketing",
    title: "Compare Google Ads vs last month",
    description:
      "Every day Zero compares Google Ads and Meta Ads spend, CPA, and ROAS against the prior period and flags anomalies in Slack.",
    behavior: [
      "Zero reads ad performance",
      "Compared to prior period",
      "Anomalies flagged in Slack",
    ],
    requiredConnectors: ["google-ads", "slack"],
    optionalConnectors: ["meta-ads"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "watch-brand-mentions",
    category: "Marketing",
    title: "Watch HN and X for brand mentions",
    description:
      "Every hour Zero searches the web, Hacker News, and X for mentions of your product and posts them to Slack.",
    behavior: [
      "Zero searches for mentions",
      "New mentions filtered",
      "Posted to Slack",
    ],
    requiredConnectors: ["exa", "slack"],
    optionalConnectors: ["x"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. hourly) so mentions surface quickly.",
  },
  {
    slug: "catch-leads-gmail",
    category: "Sales",
    title: "Catch leads from Gmail",
    description:
      "Zero scans new Gmail messages for buying signals, logs qualified leads to a Google Sheet, enriches them with Apollo, and suggests the next step in Slack.",
    behavior: [
      "Zero scans new mail",
      "Lead enriched and logged",
      "Next step suggested",
    ],
    requiredConnectors: ["gmail"],
    optionalConnectors: ["apollo", "google-sheets", "slack"],
    suggestedTrigger:
      "Add a gmail-new-message event trigger so it runs on each new incoming email.",
  },
  {
    slug: "new-gmail-contacts-hubspot",
    category: "Sales",
    title: "Add new Gmail contacts to HubSpot",
    description:
      "When an email arrives from someone not in the CRM, Zero adds and enriches them in HubSpot.",
    behavior: [
      "Zero spots an unknown sender",
      "Contact created and enriched",
      "Logged for follow-up",
    ],
    requiredConnectors: ["gmail", "hubspot"],
    optionalConnectors: ["apollo"],
    suggestedTrigger:
      "Add a gmail-new-message event trigger so it runs on each new incoming email.",
  },
  {
    slug: "research-new-signups-apollo",
    category: "Sales",
    title: "Research new signups with Apollo",
    description:
      "Every hour Zero checks Clerk for new signups, researches their background and company with Apollo, and posts a snapshot to Slack.",
    behavior: [
      "Zero reads new signups",
      "Researched with Apollo",
      "Snapshot posted to Slack",
    ],
    requiredConnectors: ["clerk", "slack"],
    optionalConnectors: ["apollo"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Clerk signups have no native event trigger, so poll on a cadence.",
  },
  {
    slug: "gmail-followups-auto",
    category: "Sales",
    title: "Send Gmail follow-ups automatically",
    description:
      "Every day Zero advances outreach sequences and drafts the next follow-up for anyone who hasn't replied.",
    behavior: [
      "Zero checks sequence status",
      "Next touch drafted",
      "Ready in Gmail",
    ],
    requiredConnectors: ["instantly", "gmail"],
    optionalConnectors: ["apollo"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every morning). Instantly has no native event trigger, so poll for non-repliers.",
  },
  {
    slug: "prep-google-calendar-meetings",
    category: "Sales",
    title: "Prep for Google Calendar meetings",
    description:
      "When a meeting with an external attendee is added, Zero researches them with Apollo and Gong and sends a prep brief to Slack.",
    behavior: [
      "A meeting is added",
      "Attendee researched",
      "Prep brief sent to Slack",
    ],
    requiredConnectors: ["google-calendar"],
    optionalConnectors: ["apollo", "gong", "slack"],
    suggestedTrigger:
      "Add a google-calendar-event-created event trigger, or a morning schedule that scans the day's meetings.",
  },
  {
    slug: "log-gong-calls-hubspot",
    category: "Sales",
    title: "Log Gong calls to HubSpot",
    description:
      "After a sales call, Zero pulls the Gong transcript and logs the notes and next steps to the HubSpot deal.",
    behavior: [
      "Zero reads the transcript",
      "Summary and next steps drafted",
      "Logged to HubSpot",
    ],
    requiredConnectors: ["gong", "hubspot"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Gong has no native event trigger, so poll for new call transcripts.",
  },
  {
    slug: "sort-route-zendesk-tickets",
    category: "Support",
    title: "Sort and route Zendesk tickets",
    description:
      "When a support ticket arrives, Zero sets its severity, routes it to the right team, and drafts a first reply.",
    behavior: [
      "A ticket arrives",
      "Severity set and routed",
      "First reply drafted",
    ],
    requiredConnectors: ["zendesk"],
    optionalConnectors: ["linear"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. every 15 minutes), or a webhook-received trigger if Zendesk can post to a webhook.",
  },
  {
    slug: "draft-replies-notion-faq",
    category: "Support",
    title: "Draft replies from your Notion FAQ",
    description:
      "When a support question arrives, Zero checks the FAQ in Notion and drafts an on-brand reply for review.",
    behavior: [
      "A question arrives",
      "Zero checks the Notion FAQ",
      "Reply drafted for review",
    ],
    requiredConnectors: ["intercom", "notion"],
    optionalConnectors: ["gmail"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. every 15 minutes), or a webhook-received trigger if Intercom can post to a webhook.",
  },
  {
    slug: "send-bugs-github-slack",
    category: "Support",
    title: "Send bugs to GitHub and Slack",
    description:
      "When an issue is labeled bug, Zero packages the reproduction steps and impact and sends it to the engineering channel.",
    behavior: [
      "An issue is labeled bug",
      "Repro and impact packaged",
      "Sent to engineering",
    ],
    requiredConnectors: ["github", "slack"],
    optionalConnectors: ["linear"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the bug label.",
  },
  {
    slug: "fixes-to-notion-help-docs",
    category: "Support",
    title: "Turn fixes into Notion help docs",
    description:
      "When a ticket is marked resolved, Zero turns the fix into a reusable help article in Notion.",
    behavior: ["A ticket is resolved", "Fix written up", "Saved to Notion"],
    requiredConnectors: ["notion"],
    optionalConnectors: ["zendesk"],
    suggestedTrigger:
      "Add a schedule trigger you run when tickets are resolved, or run it on demand.",
  },
  {
    slug: "spot-churn-risk-stripe-zendesk",
    category: "Support",
    title: "Spot churn risk in Stripe and Zendesk",
    description:
      "Every day Zero flags accounts with billing issues or a spike in tickets and drafts a recovery email.",
    behavior: [
      "Zero scans accounts",
      "At-risk accounts flagged",
      "Recovery email drafted",
    ],
    requiredConnectors: ["clerk"],
    optionalConnectors: ["stripe", "zendesk", "resend", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Stripe and Zendesk have no native event trigger here, so poll on a cadence.",
  },
  {
    slug: "summarize-zendesk-tickets-daily",
    category: "Support",
    title: "Summarize Zendesk tickets daily",
    description:
      "Every morning Zero summarizes the last 24 hours of Zendesk tickets by severity and age and posts it to Slack.",
    behavior: [
      "Zero reads the queue",
      "Grouped by severity and age",
      "Posted to Slack",
    ],
    requiredConnectors: ["zendesk", "slack"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "daily-company-brief-slack",
    category: "CEO",
    title: "Post a daily company brief to Slack",
    description:
      "Every morning Zero compiles product health, growth, revenue, and engineering into a company brief and posts it to Slack.",
    behavior: [
      "Zero gathers the signals",
      "Assembled into a pulse",
      "Posted to Slack",
    ],
    requiredConnectors: ["plausible", "slack"],
    optionalConnectors: ["clerk", "stripe", "github", "sentry"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "daily-industry-news-slack",
    category: "CEO",
    title: "Post daily industry news to Slack",
    description:
      "Every day Zero gathers AI and competitor news from the last 24 hours and posts a brief to Slack.",
    behavior: [
      "Zero scans the news",
      "Distilled into a brief",
      "Posted to Slack",
    ],
    requiredConnectors: ["exa", "slack"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "business-review-gamma",
    category: "CEO",
    title: "Build the business review in Gamma",
    description:
      "Every week Zero builds a business review deck in Gamma covering MRR, burn, runway, and growth.",
    behavior: [
      "Zero pulls the numbers",
      "Deck built in Gamma",
      "Ready to present",
    ],
    requiredConnectors: ["stripe", "gamma"],
    optionalConnectors: ["clerk"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "highlight-key-emails-gmail",
    category: "CEO",
    title: "Highlight key emails in Gmail",
    description:
      "Every morning Zero surfaces the few emails that actually need your attention and posts them to Slack.",
    behavior: [
      "Zero reads the inbox",
      "Priorities identified",
      "Posted to Slack",
    ],
    requiredConnectors: ["gmail", "slack"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a gmail-new-message event trigger, or a schedule trigger that runs a few times a day.",
  },
  {
    slug: "investor-update-google-docs",
    category: "CEO",
    title: "Draft the investor update in Google Docs",
    description:
      "Every month Zero assembles KPIs and highlights into an editable investor update in Google Docs.",
    behavior: [
      "Zero gathers KPIs",
      "Update drafted",
      "Editable in Google Docs",
    ],
    requiredConnectors: ["stripe", "google-docs"],
    optionalConnectors: ["google-sheets"],
    suggestedTrigger: "Add a schedule trigger (e.g. monthly).",
  },
  {
    slug: "gmail-reconnect-reminders",
    category: "CEO",
    title: "Get Gmail reconnect reminders",
    description:
      "Every week Zero surfaces important contacts you haven't talked to lately and suggests an opener.",
    behavior: [
      "Zero reviews your contacts",
      "Quiet relationships surfaced",
      "Openers suggested",
    ],
    requiredConnectors: ["gmail"],
    optionalConnectors: ["google-calendar", "slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "sync-asana-projects-notion",
    category: "Operations",
    title: "Sync Asana projects to Notion",
    description:
      "Every day Zero rolls up task status from Asana into a single status board in Notion and posts a digest.",
    behavior: ["Zero reads Asana", "Rolled into one board", "Digest posted"],
    requiredConnectors: ["asana", "notion"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every morning). Asana has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "meeting-notes-asana-tasks",
    category: "Operations",
    title: "Turn meeting notes into Asana tasks",
    description:
      "After a meeting, Zero extracts the action items from the transcript and creates assigned tasks in Asana.",
    behavior: [
      "Zero reads the transcript",
      "Action items extracted",
      "Tasks created in Asana",
    ],
    requiredConnectors: ["fireflies", "asana"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a google-meet-transcript-generated event trigger if you meet on Google Meet; otherwise a schedule trigger, since Fireflies has no native event trigger.",
  },
  {
    slug: "file-gmail-invoices-drive",
    category: "Operations",
    title: "File Gmail invoices to Google Drive",
    description:
      "When an invoice is labeled in Gmail, Zero saves the file to the right Google Drive folder and logs the expense in a sheet.",
    behavior: [
      "An invoice is labeled",
      "Filed to Google Drive",
      "Logged in a sheet",
    ],
    requiredConnectors: ["gmail", "google-drive"],
    optionalConnectors: ["google-sheets"],
    suggestedTrigger:
      "Add a gmail-label-applied event trigger on the label you use for invoices.",
  },
  {
    slug: "onboard-new-hires-asana",
    category: "Operations",
    title: "Onboard new hires in Asana",
    description:
      "When a new hire is added, Zero fires the onboarding checklist in Asana and provisions their docs in Google Drive.",
    behavior: [
      "A new hire is added",
      "Checklist created in Asana",
      "Docs provisioned",
    ],
    requiredConnectors: ["deel", "asana"],
    optionalConnectors: ["google-drive"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Deel has no native event trigger, so poll for new hires.",
  },
  {
    slug: "chase-overdue-asana-tasks",
    category: "Operations",
    title: "Chase overdue Asana tasks",
    description:
      "Every day Zero finds overdue tasks in Asana and nudges their owners in Slack.",
    behavior: ["Zero scans Asana", "Owners identified", "Nudges sent in Slack"],
    requiredConnectors: ["asana", "slack"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "catch-calendar-conflicts",
    category: "Operations",
    title: "Catch Google Calendar conflicts",
    description:
      "When a calendar event is created, Zero detects double-bookings and conflicts and alerts you in Slack.",
    behavior: [
      "An event is created",
      "Checked for conflicts",
      "Conflict flagged in Slack",
    ],
    requiredConnectors: ["cal-com", "google-calendar"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a google-calendar-event-created event trigger, or a morning schedule that scans the day for conflicts.",
  },
  {
    slug: "sort-gmail-draft-replies",
    category: "Everyone",
    title: "Sort Gmail and draft replies",
    description:
      "Zero sorts new Gmail messages by urgency and drafts replies for you to approve.",
    behavior: ["Zero reads new mail", "Sorted by urgency", "Replies drafted"],
    requiredConnectors: ["gmail"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a gmail-new-message event trigger so it runs on each new incoming email.",
  },
  {
    slug: "morning-brief-slack",
    category: "Everyone",
    title: "Get a morning brief in Slack",
    description:
      "Every morning Zero sends a brief with your schedule and the emails that need you, and posts it to Slack.",
    behavior: ["Zero reads your day", "Brief assembled", "Posted to Slack"],
    requiredConnectors: ["gmail", "slack"],
    optionalConnectors: ["google-calendar"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "research-calendar-meetings",
    category: "Everyone",
    title: "Research your calendar meetings",
    description:
      "When a meeting is added to your calendar, Zero researches the attendees and company and sends you a dossier before the call.",
    behavior: [
      "A meeting is added",
      "Attendees researched",
      "Dossier delivered",
    ],
    requiredConnectors: ["google-calendar"],
    optionalConnectors: ["exa", "slack"],
    suggestedTrigger:
      "Add a google-calendar-event-created event trigger, or a morning schedule that scans the day's meetings.",
  },
  {
    slug: "summarize-gmail-newsletters",
    category: "Everyone",
    title: "Summarize Gmail newsletters",
    description:
      "Every week Zero summarizes the newsletters labeled in Gmail into one digest and posts it to Slack.",
    behavior: [
      "Zero collects newsletters",
      "Digested into one summary",
      "Posted to Slack",
    ],
    requiredConnectors: ["gmail", "slack"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a schedule trigger (e.g. weekly) to digest the newsletters, or a gmail-label-applied trigger on your newsletter label.",
  },
  {
    slug: "meeting-recaps-slack",
    category: "Everyone",
    title: "Get meeting recaps in Slack",
    description:
      "After a meeting, Zero sends you a recap with the decisions and action items.",
    behavior: ["Zero reads the transcript", "Recap written", "Sent to you"],
    requiredConnectors: ["fireflies"],
    optionalConnectors: ["gmail", "slack"],
    suggestedTrigger:
      "Add a google-meet-transcript-generated event trigger if you meet on Google Meet; otherwise a schedule trigger, since Fireflies has no native event trigger.",
  },
  {
    slug: "flagged-gmail-todoist-tasks",
    category: "Everyone",
    title: "Turn flagged Gmail into Todoist tasks",
    description:
      "When you flag an email in Gmail, Zero researches the topic and files a ready-to-do task in Todoist.",
    behavior: [
      "You flag an email",
      "Zero researches it",
      "Task filed in Todoist",
    ],
    requiredConnectors: ["gmail", "todoist"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a gmail-label-applied event trigger on the label you apply to flag an email.",
  },
];

export const WORKFLOW_TEMPLATE_ITEMS: readonly WorkflowTemplateItem[] = [
  AUTO_INBOX_LABEL,
  ...WORKFLOW_TEMPLATE_SPECS.map(buildWorkflowTemplateItem),
];

export function findWorkflowTemplateItem(
  id: string,
): WorkflowTemplateItem | undefined {
  return WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === id;
  });
}
