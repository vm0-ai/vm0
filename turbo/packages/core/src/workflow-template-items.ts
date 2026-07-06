export interface WorkflowTemplateItem {
  readonly id: `workflow-template:${string}`;
  readonly title: string;
  readonly description: string;
  // Persona group used to organize the template picker. One of
  // WORKFLOW_TEMPLATE_CATEGORIES.
  readonly category: string;
  // Connector types shown as icons on the card (required first, then optional).
  // The picker filters these to the ones with a known icon.
  readonly connectors: readonly string[];
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
  // Short, user-perspective card copy (one line).
  readonly description: string;
  // The what: each line is one step of the workflow's behavior.
  readonly behavior: readonly string[];
  // Connector types for the card icons (required first, then optional).
  readonly connectors: readonly string[];
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
    connectors: spec.connectors,
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
  description: "Handle a message when a Gmail label is applied.",
  category: "General",
  connectors: ["gmail"],
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
    description: "Merge ready-to-merge PRs once CI is green.",
    behavior: [
      "A PR is labeled ready-to-merge",
      "Zero reviews and waits on CI",
      "Merged and posted to Slack",
    ],
    connectors: ["github", "vercel", "slack"],
    requiredConnectors: ["github"],
    optionalConnectors: ["vercel", "slack"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the ready-to-merge label so it runs the moment a PR is labeled.",
  },
  {
    slug: "file-sentry-crashes-github",
    category: "Engineering",
    title: "File Sentry crashes as GitHub issues",
    description: "File the worst Sentry errors as GitHub issues.",
    behavior: [
      "Zero pulls new Sentry errors",
      "Ranked by user impact",
      "Issues filed and owner pinged",
    ],
    connectors: ["sentry", "github", "linear", "slack"],
    requiredConnectors: ["sentry", "github"],
    optionalConnectors: ["linear", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. hourly). Sentry has no native event trigger yet, so poll on a cadence.",
  },
  {
    slug: "watch-sentry-after-release",
    category: "Engineering",
    title: "Watch Sentry after a release",
    description: "Flag crash-rate regressions after a release.",
    behavior: [
      "Zero watches the new release",
      "Compared against baseline",
      "Regression flagged with a rollback tip",
    ],
    connectors: ["sentry", "github", "vercel", "slack"],
    requiredConnectors: ["sentry", "github"],
    optionalConnectors: ["vercel", "slack"],
    suggestedTrigger:
      "Add a schedule trigger that runs shortly after each release. Sentry has no native event trigger, so poll and compare against the prior baseline.",
  },
  {
    slug: "post-github-updates-slack",
    category: "Engineering",
    title: "Post GitHub updates to Slack",
    description: "Post your merged and in-progress work to Slack.",
    behavior: [
      "Zero collects your activity",
      "Summarized into an update",
      "Posted to Slack",
    ],
    connectors: ["github", "linear", "sentry", "slack"],
    requiredConnectors: ["github"],
    optionalConnectors: ["linear", "sentry", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every weekday at end of day).",
  },
  {
    slug: "draft-github-release-notes-notion",
    category: "Engineering",
    title: "Draft GitHub release notes in Notion",
    description: "Turn merged PRs into release notes in Notion.",
    behavior: [
      "A PR is labeled shipped",
      "Zero gathers merged PRs",
      "Release notes saved to Notion",
    ],
    connectors: ["github", "notion", "slack"],
    requiredConnectors: ["github", "notion"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on a release label, or a schedule trigger you run per release.",
  },
  {
    slug: "report-ai-model-costs-slack",
    category: "Engineering",
    title: "Report AI model costs to Slack",
    description: "Report daily LLM spend and latency to Slack.",
    behavior: [
      "Zero reads Langfuse",
      "Broken down by model and route",
      "Posted to Slack",
    ],
    connectors: ["langfuse", "slack"],
    requiredConnectors: ["langfuse"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Langfuse has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "github-idea-to-notion-spec",
    category: "Product",
    title: "Turn a GitHub idea into a Notion spec",
    description: "Expand a GitHub issue into a Notion spec.",
    behavior: [
      "An issue is labeled needs-spec",
      "Zero expands it into a PRD",
      "Saved to Notion",
    ],
    connectors: ["github", "notion", "figma"],
    requiredConnectors: ["github", "notion"],
    optionalConnectors: ["figma"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the needs-spec label.",
  },
  {
    slug: "summarize-user-feedback-notion",
    category: "Product",
    title: "Summarize user feedback in Notion",
    description: "Cluster user feedback into a ranked Notion summary.",
    behavior: [
      "Zero pulls feedback",
      "Clustered into themes",
      "Summary saved to Notion",
    ],
    connectors: ["productlane", "notion", "typeform", "intercom", "github"],
    requiredConnectors: ["productlane", "notion"],
    optionalConnectors: ["typeform", "intercom", "github"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. weekly). These feedback sources have no native event trigger, so poll on a cadence.",
  },
  {
    slug: "post-release-notes-slack",
    category: "Product",
    title: "Post release notes to Slack",
    description: "Draft a changelog and post it to Slack.",
    behavior: [
      "A PR is labeled release",
      "Zero drafts the changelog",
      "Posted to Slack and Notion",
    ],
    connectors: ["github", "slack", "notion"],
    requiredConnectors: ["github", "slack"],
    optionalConnectors: ["notion"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the release label.",
  },
  {
    slug: "sync-linear-roadmap-notion",
    category: "Product",
    title: "Sync the Linear roadmap to Notion",
    description: "Sync Linear status into a Notion roadmap.",
    behavior: [
      "Zero reads Linear status",
      "Mapped to Now / Next / Later",
      "Board updated in Notion",
    ],
    connectors: ["linear", "notion"],
    requiredConnectors: ["linear", "notion"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Linear has no native event trigger here, so poll on a cadence.",
  },
  {
    slug: "track-feature-usage-posthog",
    category: "Product",
    title: "Track feature usage with PostHog",
    description: "Post the biggest PostHog usage shifts to Slack.",
    behavior: [
      "Zero reads PostHog",
      "Compared week over week",
      "Shifts posted to Slack",
    ],
    connectors: ["posthog", "slack"],
    requiredConnectors: ["posthog"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. weekly). PostHog has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "flag-figma-designs-no-task",
    category: "Product",
    title: "Flag Figma designs without a task",
    description: "Flag Figma designs with no linked task.",
    behavior: [
      "Zero scans Figma frames",
      "Finds frames without a task",
      "Gaps posted to Slack",
    ],
    connectors: ["figma", "linear", "slack"],
    requiredConnectors: ["figma"],
    optionalConnectors: ["linear", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Figma has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "post-daily-metrics-slack",
    category: "Data",
    title: "Post daily metrics to Slack",
    description: "Post daily visitors, signups, and activation to Slack.",
    behavior: [
      "Zero pulls the metrics",
      "Assembled into a KPI snapshot",
      "Posted to Slack",
    ],
    connectors: ["plausible", "slack", "posthog", "clerk"],
    requiredConnectors: ["plausible", "slack"],
    optionalConnectors: ["posthog", "clerk"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "run-daily-query-sheets",
    category: "Data",
    title: "Run a daily query into Google Sheets",
    description: "Run your saved query into a Google Sheet.",
    behavior: [
      "Zero runs the query",
      "Results formatted",
      "Written to Google Sheets",
    ],
    connectors: ["snowflake", "google-sheets", "slack"],
    requiredConnectors: ["snowflake", "google-sheets"],
    optionalConnectors: ["slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "check-posthog-signup-funnel",
    category: "Data",
    title: "Check the PostHog signup funnel",
    description: "Post the biggest signup-funnel drop-off to Slack.",
    behavior: [
      "Zero runs the funnel",
      "Biggest drop-off identified",
      "Posted to Slack",
    ],
    connectors: ["posthog", "slack"],
    requiredConnectors: ["posthog"],
    optionalConnectors: ["slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "alert-metric-moves-slack",
    category: "Data",
    title: "Alert when a metric moves",
    description: "Alert Slack when a key metric moves.",
    behavior: [
      "Zero checks the metric",
      "Compared to normal range",
      "Alert posted to Slack",
    ],
    connectors: ["plausible", "slack", "posthog"],
    requiredConnectors: ["plausible", "slack"],
    optionalConnectors: ["posthog"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. hourly) so anomalies surface quickly.",
  },
  {
    slug: "track-signup-sources-sheets",
    category: "Data",
    title: "Track signup sources in Google Sheets",
    description: "Attribute new signups in a tracking sheet.",
    behavior: [
      "Zero reads new signups",
      "Attributed to a channel",
      "Logged to Google Sheets",
    ],
    connectors: ["clerk", "google-sheets", "plausible"],
    requiredConnectors: ["clerk", "google-sheets"],
    optionalConnectors: ["plausible"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Clerk has no native event trigger here, so poll on a cadence.",
  },
  {
    slug: "build-weekly-deck-gamma",
    category: "Data",
    title: "Build the weekly deck in Gamma",
    description: "Build the weekly metrics deck in Gamma.",
    behavior: [
      "Zero gathers the numbers",
      "Deck built in Gamma",
      "Posted to Slack",
    ],
    connectors: ["google-sheets", "gamma", "plausible", "slack"],
    requiredConnectors: ["google-sheets", "gamma"],
    optionalConnectors: ["plausible", "slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "track-keyword-ranks-ahrefs",
    category: "Marketing",
    title: "Track keyword ranks with Ahrefs",
    description: "Report keyword-rank movers in Notion.",
    behavior: [
      "Zero reads keyword positions",
      "Movers identified",
      "Reported in Notion",
    ],
    connectors: ["ahrefs", "similarweb", "notion"],
    requiredConnectors: ["ahrefs"],
    optionalConnectors: ["similarweb", "notion"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "publish-scheduled-posts-buffer",
    category: "Marketing",
    title: "Publish scheduled posts to Buffer",
    description: "Publish today's content and queue social posts.",
    behavior: [
      "Zero reads today's calendar",
      "Published to the CMS",
      "Social queued in Buffer",
    ],
    connectors: ["notion", "strapi", "buffer"],
    requiredConnectors: ["notion", "strapi"],
    optionalConnectors: ["buffer"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every morning) to publish the day's scheduled content.",
  },
  {
    slug: "blog-posts-to-x",
    category: "Marketing",
    title: "Turn blog posts into X posts",
    description: "Turn new blog posts into queued X posts.",
    behavior: [
      "Zero finds new posts",
      "Cut into social variants",
      "Queued in Buffer",
    ],
    connectors: ["strapi", "buffer", "x"],
    requiredConnectors: ["strapi", "buffer"],
    optionalConnectors: ["x"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Publishing has no native event trigger, so poll for newly published posts.",
  },
  {
    slug: "draft-newsletter-mailchimp",
    category: "Marketing",
    title: "Draft the newsletter in Mailchimp",
    description: "Stage a newsletter draft in Mailchimp.",
    behavior: [
      "Zero gathers what shipped",
      "Newsletter drafted",
      "Staged in Mailchimp",
    ],
    connectors: ["github", "mailchimp"],
    requiredConnectors: ["github", "mailchimp"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. monthly).",
  },
  {
    slug: "compare-google-ads-last-month",
    category: "Marketing",
    title: "Compare Google Ads vs last month",
    description: "Flag ad spend and ROAS anomalies in Slack.",
    behavior: [
      "Zero reads ad performance",
      "Compared to prior period",
      "Anomalies flagged in Slack",
    ],
    connectors: ["google-ads", "slack", "meta-ads"],
    requiredConnectors: ["google-ads", "slack"],
    optionalConnectors: ["meta-ads"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "watch-brand-mentions",
    category: "Marketing",
    title: "Watch HN and X for brand mentions",
    description: "Post new brand mentions to Slack.",
    behavior: [
      "Zero searches for mentions",
      "New mentions filtered",
      "Posted to Slack",
    ],
    connectors: ["exa", "slack", "x"],
    requiredConnectors: ["exa", "slack"],
    optionalConnectors: ["x"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. hourly) so mentions surface quickly.",
  },
  {
    slug: "catch-leads-gmail",
    category: "Sales",
    title: "Catch leads from Gmail",
    description: "Log qualified leads from your inbox.",
    behavior: [
      "Zero scans new mail",
      "Lead enriched and logged",
      "Next step suggested",
    ],
    connectors: ["gmail", "apollo", "google-sheets", "slack"],
    requiredConnectors: ["gmail"],
    optionalConnectors: ["apollo", "google-sheets", "slack"],
    suggestedTrigger:
      "Add a gmail-new-message event trigger so it runs on each new incoming email.",
  },
  {
    slug: "new-gmail-contacts-hubspot",
    category: "Sales",
    title: "Add new Gmail contacts to HubSpot",
    description: "Add unknown email senders to HubSpot.",
    behavior: [
      "Zero spots an unknown sender",
      "Contact created and enriched",
      "Logged for follow-up",
    ],
    connectors: ["gmail", "hubspot", "apollo"],
    requiredConnectors: ["gmail", "hubspot"],
    optionalConnectors: ["apollo"],
    suggestedTrigger:
      "Add a gmail-new-message event trigger so it runs on each new incoming email.",
  },
  {
    slug: "research-new-signups-apollo",
    category: "Sales",
    title: "Research new signups with Apollo",
    description: "Research new signups and post a snapshot.",
    behavior: [
      "Zero reads new signups",
      "Researched with Apollo",
      "Snapshot posted to Slack",
    ],
    connectors: ["clerk", "slack", "apollo"],
    requiredConnectors: ["clerk", "slack"],
    optionalConnectors: ["apollo"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Clerk signups have no native event trigger, so poll on a cadence.",
  },
  {
    slug: "gmail-followups-auto",
    category: "Sales",
    title: "Send Gmail follow-ups automatically",
    description: "Draft the next follow-up for non-repliers.",
    behavior: [
      "Zero checks sequence status",
      "Next touch drafted",
      "Ready in Gmail",
    ],
    connectors: ["instantly", "gmail", "apollo"],
    requiredConnectors: ["instantly", "gmail"],
    optionalConnectors: ["apollo"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every morning). Instantly has no native event trigger, so poll for non-repliers.",
  },
  {
    slug: "prep-google-calendar-meetings",
    category: "Sales",
    title: "Prep for Google Calendar meetings",
    description: "Get a prep brief before external meetings.",
    behavior: [
      "A meeting is added",
      "Attendee researched",
      "Prep brief sent to Slack",
    ],
    connectors: ["google-calendar", "apollo", "gong", "slack"],
    requiredConnectors: ["google-calendar"],
    optionalConnectors: ["apollo", "gong", "slack"],
    suggestedTrigger:
      "Add a google-calendar-event-created event trigger, or a morning schedule that scans the day's meetings.",
  },
  {
    slug: "log-gong-calls-hubspot",
    category: "Sales",
    title: "Log Gong calls to HubSpot",
    description: "Log Gong call notes to the HubSpot deal.",
    behavior: [
      "Zero reads the transcript",
      "Summary and next steps drafted",
      "Logged to HubSpot",
    ],
    connectors: ["gong", "hubspot", "slack"],
    requiredConnectors: ["gong", "hubspot"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Gong has no native event trigger, so poll for new call transcripts.",
  },
  {
    slug: "sort-route-zendesk-tickets",
    category: "Support",
    title: "Sort and route Zendesk tickets",
    description: "Triage, route, and draft replies for tickets.",
    behavior: [
      "A ticket arrives",
      "Severity set and routed",
      "First reply drafted",
    ],
    connectors: ["zendesk", "linear"],
    requiredConnectors: ["zendesk"],
    optionalConnectors: ["linear"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. every 15 minutes), or a webhook-received trigger if Zendesk can post to a webhook.",
  },
  {
    slug: "draft-replies-notion-faq",
    category: "Support",
    title: "Draft replies from your Notion FAQ",
    description: "Draft ticket replies from your Notion FAQ.",
    behavior: [
      "A question arrives",
      "Zero checks the Notion FAQ",
      "Reply drafted for review",
    ],
    connectors: ["intercom", "notion", "gmail"],
    requiredConnectors: ["intercom", "notion"],
    optionalConnectors: ["gmail"],
    suggestedTrigger:
      "Add a schedule trigger on a tight cadence (e.g. every 15 minutes), or a webhook-received trigger if Intercom can post to a webhook.",
  },
  {
    slug: "send-bugs-github-slack",
    category: "Support",
    title: "Send bugs to GitHub and Slack",
    description: "Send bug reports to the engineering channel.",
    behavior: [
      "An issue is labeled bug",
      "Repro and impact packaged",
      "Sent to engineering",
    ],
    connectors: ["github", "slack", "linear"],
    requiredConnectors: ["github", "slack"],
    optionalConnectors: ["linear"],
    suggestedTrigger:
      "Add a github-label-applied event trigger on the bug label.",
  },
  {
    slug: "fixes-to-notion-help-docs",
    category: "Support",
    title: "Turn fixes into Notion help docs",
    description: "Turn a resolved ticket into a help article.",
    behavior: ["A ticket is resolved", "Fix written up", "Saved to Notion"],
    connectors: ["notion", "zendesk"],
    requiredConnectors: ["notion"],
    optionalConnectors: ["zendesk"],
    suggestedTrigger:
      "Add a schedule trigger you run when tickets are resolved, or run it on demand.",
  },
  {
    slug: "spot-churn-risk-stripe-zendesk",
    category: "Support",
    title: "Spot churn risk in Stripe and Zendesk",
    description: "Flag churn-risk accounts and draft recovery emails.",
    behavior: [
      "Zero scans accounts",
      "At-risk accounts flagged",
      "Recovery email drafted",
    ],
    connectors: ["clerk", "stripe", "zendesk", "resend", "slack"],
    requiredConnectors: ["clerk"],
    optionalConnectors: ["stripe", "zendesk", "resend", "slack"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Stripe and Zendesk have no native event trigger here, so poll on a cadence.",
  },
  {
    slug: "summarize-zendesk-tickets-daily",
    category: "Support",
    title: "Summarize Zendesk tickets daily",
    description: "Summarize the last day of tickets to Slack.",
    behavior: [
      "Zero reads the queue",
      "Grouped by severity and age",
      "Posted to Slack",
    ],
    connectors: ["zendesk", "slack"],
    requiredConnectors: ["zendesk", "slack"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "daily-company-brief-slack",
    category: "CEO",
    title: "Post a daily company brief to Slack",
    description: "Post a daily company brief to Slack.",
    behavior: [
      "Zero gathers the signals",
      "Assembled into a pulse",
      "Posted to Slack",
    ],
    connectors: ["plausible", "slack", "clerk", "stripe", "github", "sentry"],
    requiredConnectors: ["plausible", "slack"],
    optionalConnectors: ["clerk", "stripe", "github", "sentry"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "daily-industry-news-slack",
    category: "CEO",
    title: "Post daily industry news to Slack",
    description: "Post a daily industry-news brief to Slack.",
    behavior: [
      "Zero scans the news",
      "Distilled into a brief",
      "Posted to Slack",
    ],
    connectors: ["exa", "slack"],
    requiredConnectors: ["exa", "slack"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "business-review-gamma",
    category: "CEO",
    title: "Build the business review in Gamma",
    description: "Build the business review deck in Gamma.",
    behavior: [
      "Zero pulls the numbers",
      "Deck built in Gamma",
      "Ready to present",
    ],
    connectors: ["stripe", "gamma", "clerk"],
    requiredConnectors: ["stripe", "gamma"],
    optionalConnectors: ["clerk"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "highlight-key-emails-gmail",
    category: "CEO",
    title: "Highlight key emails in Gmail",
    description: "Surface the emails that need you.",
    behavior: [
      "Zero reads the inbox",
      "Priorities identified",
      "Posted to Slack",
    ],
    connectors: ["gmail", "slack"],
    requiredConnectors: ["gmail", "slack"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a gmail-new-message event trigger, or a schedule trigger that runs a few times a day.",
  },
  {
    slug: "investor-update-google-docs",
    category: "CEO",
    title: "Draft the investor update in Google Docs",
    description: "Assemble the investor update in Google Docs.",
    behavior: [
      "Zero gathers KPIs",
      "Update drafted",
      "Editable in Google Docs",
    ],
    connectors: ["stripe", "google-docs", "google-sheets"],
    requiredConnectors: ["stripe", "google-docs"],
    optionalConnectors: ["google-sheets"],
    suggestedTrigger: "Add a schedule trigger (e.g. monthly).",
  },
  {
    slug: "gmail-reconnect-reminders",
    category: "CEO",
    title: "Get Gmail reconnect reminders",
    description: "Surface contacts worth reconnecting with.",
    behavior: [
      "Zero reviews your contacts",
      "Quiet relationships surfaced",
      "Openers suggested",
    ],
    connectors: ["gmail", "google-calendar", "slack"],
    requiredConnectors: ["gmail"],
    optionalConnectors: ["google-calendar", "slack"],
    suggestedTrigger: "Add a schedule trigger (e.g. weekly).",
  },
  {
    slug: "sync-asana-projects-notion",
    category: "Operations",
    title: "Sync Asana projects to Notion",
    description: "Roll up Asana status into a Notion board.",
    behavior: ["Zero reads Asana", "Rolled into one board", "Digest posted"],
    connectors: ["asana", "notion"],
    requiredConnectors: ["asana", "notion"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a schedule trigger (e.g. every morning). Asana has no native event trigger, so poll on a cadence.",
  },
  {
    slug: "meeting-notes-asana-tasks",
    category: "Operations",
    title: "Turn meeting notes into Asana tasks",
    description: "Turn meeting notes into assigned Asana tasks.",
    behavior: [
      "Zero reads the transcript",
      "Action items extracted",
      "Tasks created in Asana",
    ],
    connectors: ["fireflies", "asana"],
    requiredConnectors: ["fireflies", "asana"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a google-meet-transcript-generated event trigger if you meet on Google Meet; otherwise a schedule trigger, since Fireflies has no native event trigger.",
  },
  {
    slug: "file-gmail-invoices-drive",
    category: "Operations",
    title: "File Gmail invoices to Google Drive",
    description: "File Gmail invoices to Drive and log them.",
    behavior: [
      "An invoice is labeled",
      "Filed to Google Drive",
      "Logged in a sheet",
    ],
    connectors: ["gmail", "google-drive", "google-sheets"],
    requiredConnectors: ["gmail", "google-drive"],
    optionalConnectors: ["google-sheets"],
    suggestedTrigger:
      "Add a gmail-label-applied event trigger on the label you use for invoices.",
  },
  {
    slug: "onboard-new-hires-asana",
    category: "Operations",
    title: "Onboard new hires in Asana",
    description: "Set up onboarding tasks for a new hire.",
    behavior: [
      "A new hire is added",
      "Checklist created in Asana",
      "Docs provisioned",
    ],
    connectors: ["deel", "asana", "google-drive"],
    requiredConnectors: ["deel", "asana"],
    optionalConnectors: ["google-drive"],
    suggestedTrigger:
      "Add a schedule trigger (e.g. daily). Deel has no native event trigger, so poll for new hires.",
  },
  {
    slug: "chase-overdue-asana-tasks",
    category: "Operations",
    title: "Chase overdue Asana tasks",
    description: "Nudge owners of overdue Asana tasks.",
    behavior: ["Zero scans Asana", "Owners identified", "Nudges sent in Slack"],
    connectors: ["asana", "slack"],
    requiredConnectors: ["asana", "slack"],
    optionalConnectors: [],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "catch-calendar-conflicts",
    category: "Operations",
    title: "Catch Google Calendar conflicts",
    description: "Alert you to calendar double-bookings.",
    behavior: [
      "An event is created",
      "Checked for conflicts",
      "Conflict flagged in Slack",
    ],
    connectors: ["cal-com", "google-calendar", "slack"],
    requiredConnectors: ["cal-com", "google-calendar"],
    optionalConnectors: ["slack"],
    suggestedTrigger:
      "Add a google-calendar-event-created event trigger, or a morning schedule that scans the day for conflicts.",
  },
  {
    slug: "sort-gmail-draft-replies",
    category: "Everyone",
    title: "Sort Gmail and draft replies",
    description: "Sort your inbox and draft replies.",
    behavior: ["Zero reads new mail", "Sorted by urgency", "Replies drafted"],
    connectors: ["gmail"],
    requiredConnectors: ["gmail"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a gmail-new-message event trigger so it runs on each new incoming email.",
  },
  {
    slug: "morning-brief-slack",
    category: "Everyone",
    title: "Get a morning brief in Slack",
    description: "Send a morning brief to Slack.",
    behavior: ["Zero reads your day", "Brief assembled", "Posted to Slack"],
    connectors: ["gmail", "slack", "google-calendar"],
    requiredConnectors: ["gmail", "slack"],
    optionalConnectors: ["google-calendar"],
    suggestedTrigger: "Add a schedule trigger (e.g. every morning).",
  },
  {
    slug: "research-calendar-meetings",
    category: "Everyone",
    title: "Research your calendar meetings",
    description: "Research attendees before each meeting.",
    behavior: [
      "A meeting is added",
      "Attendees researched",
      "Dossier delivered",
    ],
    connectors: ["google-calendar", "exa", "slack"],
    requiredConnectors: ["google-calendar"],
    optionalConnectors: ["exa", "slack"],
    suggestedTrigger:
      "Add a google-calendar-event-created event trigger, or a morning schedule that scans the day's meetings.",
  },
  {
    slug: "summarize-gmail-newsletters",
    category: "Everyone",
    title: "Summarize Gmail newsletters",
    description: "Digest your newsletters into one summary.",
    behavior: [
      "Zero collects newsletters",
      "Digested into one summary",
      "Posted to Slack",
    ],
    connectors: ["gmail", "slack"],
    requiredConnectors: ["gmail", "slack"],
    optionalConnectors: [],
    suggestedTrigger:
      "Add a schedule trigger (e.g. weekly) to digest the newsletters, or a gmail-label-applied trigger on your newsletter label.",
  },
  {
    slug: "meeting-recaps-slack",
    category: "Everyone",
    title: "Get meeting recaps in Slack",
    description: "Send a recap with decisions and action items.",
    behavior: ["Zero reads the transcript", "Recap written", "Sent to you"],
    connectors: ["fireflies", "gmail", "slack"],
    requiredConnectors: ["fireflies"],
    optionalConnectors: ["gmail", "slack"],
    suggestedTrigger:
      "Add a google-meet-transcript-generated event trigger if you meet on Google Meet; otherwise a schedule trigger, since Fireflies has no native event trigger.",
  },
  {
    slug: "flagged-gmail-todoist-tasks",
    category: "Everyone",
    title: "Turn flagged Gmail into Todoist tasks",
    description: "Turn flagged emails into Todoist tasks.",
    behavior: [
      "You flag an email",
      "Zero researches it",
      "Task filed in Todoist",
    ],
    connectors: ["gmail", "todoist"],
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
