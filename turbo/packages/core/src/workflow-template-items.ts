export interface WorkflowTemplateItem {
  readonly id: `workflow-template:${string}`;
  readonly title: string;
  readonly description: string;
  // Persona group used to organize the template picker. One of
  // WORKFLOW_TEMPLATE_CATEGORIES.
  readonly category: string;
  // Connector slugs shown as icons on the card. Typed loosely because the
  // catalog is curated by hand; the picker filters these to entries with an
  // icon.
  readonly connectors: readonly string[];
  readonly promptGuidance: string;
}

// Ordered persona groups for the template picker. "Everyone" leads and holds the
// generic starter template; the rest mirror the onboarding personas.
export const WORKFLOW_TEMPLATE_CATEGORIES: readonly string[] = [
  "Everyone",
  "Engineering",
  "Product",
  "Data",
  "Marketing",
  "Sales",
  "Support",
  "CEO",
  "Operations",
];

// Built-in workflow templates. Each entry compiles into promptGuidance that
// instructs the agent to build a workflow (via the workflow-setup skill) rather
// than run a one-shot prompt. This set merges the curated gallery (#20409) with
// the persona-bucketed catalog derived from the onboarding cards.
function defineWorkflowTemplate(args: {
  readonly id: WorkflowTemplateItem["id"];
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly connectors: readonly string[];
  readonly behavior: readonly string[];
  readonly missingInfo: string;
}): WorkflowTemplateItem {
  return {
    id: args.id,
    title: args.title,
    description: args.description,
    category: args.category,
    connectors: args.connectors,
    promptGuidance: [
      "# Workflow Template Context",
      "",
      `The user selected the built-in workflow template: ${args.title} (${args.id}).`,
      "Use the workflow-setup skill to help the user create or remix a workflow for this agent.",
      "Do not execute an existing workflow. This template is only context for creating or updating a workflow.",
      "Save the reusable workflow draft as soon as the template behavior is clear. Do not wait for connector setup or automation details.",
      "Keep the draft without an automation until the user confirms any missing trigger and safety choices.",
      "",
      "Template behavior:",
      ...args.behavior.map((line) => {
        return `- ${line}`;
      }),
      "",
      args.missingInfo,
    ].join("\n"),
  };
}

export const WORKFLOW_TEMPLATE_ITEMS: readonly WorkflowTemplateItem[] = [
  defineWorkflowTemplate({
    id: "workflow-template:auto-inbox-label",
    category: "Everyone",
    title: "Auto-inbox label",
    description:
      "Create a workflow that runs when a Gmail label is applied and handles the labeled inbox item.",
    connectors: ["gmail"],
    behavior: [
      "Create a workflow that reacts when a named Gmail label is applied to a message.",
      "Treat the labeled message as the inbox item to process.",
      "Inspect the message context, decide the requested handling path, and prepare the appropriate follow-up.",
      "Add a Gmail label-applied automation for the workflow once the user confirms the label name.",
    ],
    missingInfo:
      "Connectors: gmail required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Gmail label name, handling rules, and final action.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:daily-standup-report",
    category: "Engineering",
    title: "Daily standup report",
    description:
      "Pull product and engineering signals each morning, create a short report, and post it to Slack.",
    connectors: ["github", "sentry", "axiom", "plausible", "slack"],
    behavior: [
      "Create a scheduled workflow that runs every weekday or every morning.",
      "Pull recent GitHub activity, Sentry issues, Axiom metrics, and Plausible traffic signals.",
      "Summarize changes, incidents, usage movement, blockers, and notable risks.",
      "Post the final standup report to a Slack channel selected by the user.",
    ],
    missingInfo:
      "Connectors: github, slack required; sentry, axiom, plausible optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the schedule, timezone, Slack channel, metric scope, and any required report sections.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:github-pr-summarizer",
    category: "Engineering",
    title: "GitHub PR summarizer",
    description:
      "Collect merged pull requests, save a structured report in Notion, and optionally post to Slack.",
    connectors: ["github", "notion", "slack"],
    behavior: [
      "Create a daily or weekly scheduled workflow for one or more GitHub repositories.",
      "Find merged pull requests in the selected time window and group them by product or code area.",
      "Write a concise user-impact summary with links to the relevant pull requests.",
      "Save the report in Notion and optionally post a shorter version to Slack.",
    ],
    missingInfo:
      "Connectors: github, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the repositories, cadence, timezone, Notion destination, Slack destination, and grouping rules.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sentry-issue-digest",
    category: "Engineering",
    title: "Sentry issue digest",
    description:
      "Send a daily digest of critical and high-severity Sentry issues to Slack.",
    connectors: ["sentry", "slack"],
    behavior: [
      "Create a daily scheduled workflow that checks selected Sentry projects.",
      "Group active issues by severity, recency, affected users, and ownership when available.",
      "Highlight regressions, repeated failures, and issues needing escalation.",
      "Post the digest to a Slack channel with links back to Sentry.",
    ],
    missingInfo:
      "Connectors: sentry, slack required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Sentry projects, severity threshold, schedule, timezone, and Slack channel.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:vercel-deploy-digest",
    category: "Engineering",
    title: "Vercel deploy digest",
    description:
      "Monitor Vercel deployments, link them to GitHub commits, and alert Slack on failures.",
    connectors: ["vercel", "github", "slack"],
    behavior: [
      "Create a workflow that monitors selected Vercel projects on a schedule or via webhook when available.",
      "Link deployments to GitHub commits, pull requests, and authors when possible.",
      "Summarize recent successful deployments and call out failed or stuck deployments.",
      "Send Slack alerts for failures and optionally send a periodic deployment digest.",
    ],
    missingInfo:
      "Connectors: vercel, slack required; github optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Vercel projects, GitHub repositories, alert rules, cadence, and Slack channel.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:auto-merge-github-prs",
    category: "Engineering",
    title: "Auto-merge GitHub PRs",
    description:
      "Review PRs labeled ready-to-merge, wait for CI, then merge and post to Slack.",
    connectors: ["github", "vercel", "slack"],
    behavior: [
      "A PR is labeled ready-to-merge",
      "Zero reviews and waits on CI",
      "Merged and posted to Slack",
    ],
    missingInfo:
      "Connectors: github required; vercel, slack optional.\nSuggested trigger: Add a github-label-applied event trigger on the ready-to-merge label so it runs the moment a PR is labeled.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask for the repository, whether Zero may merge or should only recommend a merge, and the merge method. Ask only one short question at a time. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:file-sentry-crashes-github",
    category: "Engineering",
    title: "File Sentry crashes as GitHub issues",
    description:
      "Rank new Sentry errors by user impact and file the worst as GitHub issues.",
    connectors: ["sentry", "github", "linear", "slack"],
    behavior: [
      "Zero pulls new Sentry errors",
      "Ranked by user impact",
      "Issues filed and owner pinged",
    ],
    missingInfo:
      "Connectors: sentry, github required; linear, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. hourly). Sentry has no native event trigger yet, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:draft-github-release-notes-notion",
    category: "Engineering",
    title: "Draft GitHub release notes in Notion",
    description:
      "Turn the PRs merged since the last release into clean notes in Notion.",
    connectors: ["github", "notion", "slack"],
    behavior: [
      "A PR is labeled shipped",
      "Zero gathers merged PRs",
      "Release notes saved to Notion",
    ],
    missingInfo:
      "Connectors: github, notion required; slack optional.\nSuggested trigger: Add a github-label-applied event trigger on a release label, or a schedule trigger you run per release.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:feedback-router",
    category: "Product",
    title: "Feedback router",
    description:
      "Watch a Slack channel and route product feedback into Notion with labels and owners.",
    connectors: ["slack", "notion"],
    behavior: [
      "Create a workflow that reviews messages from a selected Slack feedback channel.",
      "Classify feedback into themes, priority, sentiment, and affected product area.",
      "Create structured Notion records with links back to the source Slack messages.",
      "Optionally tag an owner or add follow-up notes based on the user's routing rules.",
    ],
    missingInfo:
      "Connectors: slack, notion required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Slack channel, Notion database, taxonomy, owner mapping, and run cadence.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:github-idea-to-notion-spec",
    category: "Product",
    title: "Turn a GitHub idea into a Notion spec",
    description:
      "Expand a labeled GitHub issue into a structured product spec in Notion.",
    connectors: ["github", "notion", "figma"],
    behavior: [
      "An issue is labeled needs-spec",
      "Zero expands it into a PRD",
      "Saved to Notion",
    ],
    missingInfo:
      "Connectors: github, notion required; figma optional.\nSuggested trigger: Add a github-label-applied event trigger on the needs-spec label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:post-release-notes-slack",
    category: "Product",
    title: "Post release notes to Slack",
    description:
      "Draft a changelog from recently shipped work and post it to Slack.",
    connectors: ["github", "slack", "notion"],
    behavior: [
      "A PR is labeled release",
      "Zero drafts the changelog",
      "Posted to Slack and Notion",
    ],
    missingInfo:
      "Connectors: github, slack required; notion optional.\nSuggested trigger: Add a github-label-applied event trigger on the release label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sync-linear-roadmap-notion",
    category: "Product",
    title: "Sync the Linear roadmap to Notion",
    description: "Keep a Notion roadmap in sync with your Linear issue status.",
    connectors: ["linear", "notion"],
    behavior: [
      "Zero reads Linear status",
      "Mapped to Now / Next / Later",
      "Board updated in Notion",
    ],
    missingInfo:
      "Connectors: linear, notion required.\nSuggested trigger: Add a schedule trigger (e.g. daily). Linear has no native event trigger here, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:track-feature-usage-posthog",
    category: "Product",
    title: "Track feature usage with PostHog",
    description:
      "Surface the biggest weekly shifts in feature usage from PostHog.",
    connectors: ["posthog", "slack"],
    behavior: [
      "Zero reads PostHog",
      "Compared week over week",
      "Shifts posted to Slack",
    ],
    missingInfo:
      "Connectors: posthog required; slack optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly). PostHog has no native event trigger, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:flag-figma-designs-no-task",
    category: "Product",
    title: "Flag Figma designs without a task",
    description: "Flag Figma designs that have no linked Linear task yet.",
    connectors: ["figma", "linear", "slack"],
    behavior: [
      "Zero scans Figma frames",
      "Finds frames without a task",
      "Gaps posted to Slack",
    ],
    missingInfo:
      "Connectors: figma required; linear, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Figma has no native event trigger, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:revenuecat-subscription-digest",
    category: "Data",
    title: "RevenueCat subscription digest",
    description:
      "Track subscriptions in Sheets and alert Slack when churn or cancellation patterns change.",
    connectors: ["revenuecat", "google-sheets", "slack"],
    behavior: [
      "Create a daily scheduled workflow that pulls RevenueCat subscription activity.",
      "Log new subscriptions, renewals, cancellations, and notable churn signals in Google Sheets.",
      "Compare recent movement against the user's alert thresholds.",
      "Post a Slack summary and send urgent alerts when churn spikes.",
    ],
    missingInfo:
      "Connectors: revenuecat, google-sheets required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the RevenueCat project, schedule, timezone, Sheets destination, Slack channel, and alert thresholds.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:post-daily-metrics-slack",
    category: "Data",
    title: "Post daily metrics to Slack",
    description:
      "Post daily visitors, signups, and activation numbers to Slack.",
    connectors: ["plausible", "slack", "posthog", "clerk"],
    behavior: [
      "Zero pulls the metrics",
      "Assembled into a KPI snapshot",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: plausible, slack required; posthog, clerk optional.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:run-daily-query-sheets",
    category: "Data",
    title: "Run a daily query into Google Sheets",
    description:
      "Run your saved SQL on a schedule and append the results to a Sheet.",
    connectors: ["snowflake", "google-sheets", "slack"],
    behavior: [
      "Zero runs the query",
      "Results formatted",
      "Written to Google Sheets",
    ],
    missingInfo:
      "Connectors: snowflake, google-sheets required; slack optional.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:check-posthog-signup-funnel",
    category: "Data",
    title: "Check the PostHog signup funnel",
    description:
      "Track the signup funnel and post the biggest drop-off to Slack.",
    connectors: ["posthog", "slack"],
    behavior: [
      "Zero runs the funnel",
      "Biggest drop-off identified",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: posthog required; slack optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:alert-metric-moves-slack",
    category: "Data",
    title: "Alert when a metric moves",
    description:
      "Watch your key metrics and alert Slack when one moves sharply.",
    connectors: ["plausible", "slack", "posthog"],
    behavior: [
      "Zero checks the metric",
      "Compared to normal range",
      "Alert posted to Slack",
    ],
    missingInfo:
      "Connectors: plausible, slack required; posthog optional.\nSuggested trigger: Add a schedule trigger on a tight cadence (e.g. hourly) so anomalies surface quickly.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:track-signup-sources-sheets",
    category: "Data",
    title: "Track signup sources in Google Sheets",
    description: "Attribute each new signup to its source in a tracking Sheet.",
    connectors: ["clerk", "google-sheets", "plausible"],
    behavior: [
      "Zero reads new signups",
      "Attributed to a channel",
      "Logged to Google Sheets",
    ],
    missingInfo:
      "Connectors: clerk, google-sheets required; plausible optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Clerk has no native event trigger here, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:build-weekly-deck-gamma",
    category: "Data",
    title: "Build the weekly deck in Gamma",
    description:
      "Turn the week's metrics into a ready-to-present deck in Gamma.",
    connectors: ["google-sheets", "gamma", "plausible", "slack"],
    behavior: [
      "Zero gathers the numbers",
      "Deck built in Gamma",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: google-sheets, gamma required; plausible, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:competitive-intel-monitor",
    category: "Marketing",
    title: "Competitive intel monitor",
    description:
      "Monitor competitor sites for pricing and feature changes, save findings to Notion, and alert Slack.",
    connectors: ["firecrawl", "notion", "slack"],
    behavior: [
      "Create a weekly or daily scheduled workflow for a list of competitor pages.",
      "Use Firecrawl to detect meaningful pricing, packaging, messaging, and feature changes.",
      "Save structured findings with source links and change summaries in Notion.",
      "Post Slack alerts for important changes that need review.",
    ],
    missingInfo:
      "Connectors: firecrawl, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among competitor URLs, cadence, timezone, Notion destination, Slack channel, and alert criteria.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:x-brand-monitor",
    category: "Marketing",
    title: "X brand monitor",
    description:
      "Track brand mentions on X, save relevant posts in Notion, and alert Slack on high-signal mentions.",
    connectors: ["x", "notion", "slack"],
    behavior: [
      "Create a scheduled workflow that searches X for product, company, or keyword mentions.",
      "Filter posts for relevance, engagement, sentiment, and response urgency.",
      "Save notable mentions to a Notion database with source links and suggested follow-up.",
      "Send Slack alerts for high-engagement, urgent, or reputationally sensitive posts.",
    ],
    missingInfo:
      "Connectors: x, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the keywords or accounts, cadence, Notion database, Slack channel, and alert thresholds.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:track-keyword-ranks-ahrefs",
    category: "Marketing",
    title: "Track keyword ranks with Ahrefs",
    description:
      "Track keyword rankings in Ahrefs and report the movers in Notion.",
    connectors: ["ahrefs", "similarweb", "notion"],
    behavior: [
      "Zero reads keyword positions",
      "Movers identified",
      "Reported in Notion",
    ],
    missingInfo:
      "Connectors: ahrefs required; similarweb, notion optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:publish-scheduled-posts-buffer",
    category: "Marketing",
    title: "Publish scheduled posts to Buffer",
    description:
      "Publish the day's scheduled content and queue the social posts.",
    connectors: ["notion", "strapi", "buffer"],
    behavior: [
      "Zero reads today's calendar",
      "Published to the CMS",
      "Social queued in Buffer",
    ],
    missingInfo:
      "Connectors: notion, strapi required; buffer optional.\nSuggested trigger: Add a schedule trigger (e.g. every morning) to publish the day's scheduled content.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:blog-posts-to-x",
    category: "Marketing",
    title: "Turn blog posts into social posts",
    description:
      "Turn each new blog post into social variants queued via Buffer.",
    connectors: ["strapi", "buffer", "x"],
    behavior: [
      "Zero finds new posts",
      "Cut into social variants",
      "Queued in Buffer",
    ],
    missingInfo:
      "Connectors: strapi, buffer required; x optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Publishing has no native event trigger, so poll for newly published posts.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:draft-newsletter-mailchimp",
    category: "Marketing",
    title: "Draft the newsletter in Mailchimp",
    description:
      "Assemble recent updates into a newsletter draft in Mailchimp.",
    connectors: ["github", "mailchimp"],
    behavior: [
      "Zero gathers what shipped",
      "Newsletter drafted",
      "Staged in Mailchimp",
    ],
    missingInfo:
      "Connectors: github, mailchimp required.\nSuggested trigger: Add a schedule trigger (e.g. monthly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:compare-google-ads-last-month",
    category: "Marketing",
    title: "Compare Google Ads vs last month",
    description:
      "Compare ad spend and ROAS to last month and flag anomalies in Slack.",
    connectors: ["google-ads", "slack", "meta-ads"],
    behavior: [
      "Zero reads ad performance",
      "Compared to prior period",
      "Anomalies flagged in Slack",
    ],
    missingInfo:
      "Connectors: google-ads, slack required; meta-ads optional.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:salesforce-pipeline-digest",
    category: "Sales",
    title: "Salesforce pipeline digest",
    description:
      "Summarize Salesforce opportunity changes and close-date risks in Slack each week.",
    connectors: ["salesforce", "slack"],
    behavior: [
      "Create a weekly scheduled workflow that reviews selected Salesforce opportunities.",
      "Summarize new opportunities, stage changes, close-date movement, and blocked deals.",
      "Highlight risks, stale opportunities, and follow-ups due soon.",
      "Post the pipeline digest to a Slack channel.",
    ],
    missingInfo:
      "Connectors: salesforce, slack required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Salesforce object scope, cadence, timezone, Slack channel, and pipeline rules.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:catch-leads-gmail",
    category: "Sales",
    title: "Catch leads from Gmail",
    description:
      "Spot buying signals in new email and log the qualified leads.",
    connectors: ["gmail", "apollo", "google-sheets", "slack"],
    behavior: [
      "Zero scans new mail",
      "Lead enriched and logged",
      "Next step suggested",
    ],
    missingInfo:
      "Connectors: gmail required; apollo, google-sheets, slack optional.\nSuggested trigger: Add a gmail-new-message event trigger so it runs on each new incoming email.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:new-gmail-contacts-hubspot",
    category: "Sales",
    title: "Add new Gmail contacts to HubSpot",
    description: "Add and enrich unknown email senders as HubSpot contacts.",
    connectors: ["gmail", "hubspot", "apollo"],
    behavior: [
      "Zero spots an unknown sender",
      "Contact created and enriched",
      "Logged for follow-up",
    ],
    missingInfo:
      "Connectors: gmail, hubspot required; apollo optional.\nSuggested trigger: Add a gmail-new-message event trigger so it runs on each new incoming email.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:research-new-signups-apollo",
    category: "Sales",
    title: "Research new signups",
    description: "Research each new signup and post a quick snapshot.",
    connectors: ["clerk", "slack", "apollo"],
    behavior: [
      "Zero reads new signups",
      "Researched with Apollo",
      "Snapshot posted to Slack",
    ],
    missingInfo:
      "Connectors: clerk, slack required; apollo optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Clerk signups have no native event trigger, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:gmail-followups-auto",
    category: "Sales",
    title: "Send Gmail follow-ups automatically",
    description: "Find contacts who didn't reply and draft the next follow-up.",
    connectors: ["instantly", "gmail", "apollo"],
    behavior: [
      "Zero checks sequence status",
      "Next touch drafted",
      "Ready in Gmail",
    ],
    missingInfo:
      "Connectors: instantly, gmail required; apollo optional.\nSuggested trigger: Add a schedule trigger (e.g. every morning). Instantly has no native event trigger, so poll for non-repliers.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:prep-google-calendar-meetings",
    category: "Sales",
    title: "Prep for Google Calendar meetings",
    description:
      "Research external attendees and send a prep brief before meetings.",
    connectors: ["google-calendar", "apollo", "gong", "slack"],
    behavior: [
      "A meeting is added",
      "Attendee researched",
      "Prep brief sent to Slack",
    ],
    missingInfo:
      "Connectors: google-calendar required; apollo, gong, slack optional.\nSuggested trigger: Add a google-calendar-event-created event trigger, or a morning schedule that scans the day's meetings.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:log-gong-calls-hubspot",
    category: "Sales",
    title: "Log Gong calls to HubSpot",
    description:
      "Pull notes and next steps from a Gong call into the HubSpot deal.",
    connectors: ["gong", "hubspot", "slack"],
    behavior: [
      "Zero reads the transcript",
      "Summary and next steps drafted",
      "Logged to HubSpot",
    ],
    missingInfo:
      "Connectors: gong, hubspot required; slack optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Gong has no native event trigger, so poll for new call transcripts.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:support-ticket-router",
    category: "Support",
    title: "Support ticket router",
    description:
      "Classify support emails, create Notion records, and alert Slack for critical tickets.",
    connectors: ["gmail", "notion", "slack"],
    behavior: [
      "Create a workflow that runs from a Gmail trigger or scheduled inbox scan.",
      "Classify support messages by category, priority, customer, and requested action.",
      "Create or update structured Notion records for each qualifying ticket.",
      "Alert Slack when a ticket is urgent, blocked, or needs human follow-up.",
    ],
    missingInfo:
      "Connectors: gmail, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the inbox or label, triage rules, Notion database, Slack channel, and escalation criteria.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:zendesk-knowledge-base",
    category: "Support",
    title: "Zendesk knowledge base",
    description:
      "Find recurring Zendesk questions, draft FAQ entries, and save them to Notion.",
    connectors: ["zendesk", "notion", "slack"],
    behavior: [
      "Create a scheduled workflow that reviews recent Zendesk conversations or tickets.",
      "Cluster recurring questions, gaps, and confusing product areas.",
      "Draft FAQ or knowledge-base entries in Notion with source ticket examples.",
      "Post a Slack summary when new FAQ drafts are ready for review.",
    ],
    missingInfo:
      "Connectors: zendesk, notion required; slack optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the Zendesk scope, cadence, Notion destination, Slack channel, and publishing/review rules.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:draft-replies-notion-faq",
    category: "Support",
    title: "Draft replies from your Notion FAQ",
    description: "Draft ticket replies grounded in your Notion FAQ.",
    connectors: ["intercom", "notion", "gmail"],
    behavior: [
      "A question arrives",
      "Zero checks the Notion FAQ",
      "Reply drafted for review",
    ],
    missingInfo:
      "Connectors: intercom, notion required; gmail optional.\nSuggested trigger: Add a schedule trigger on a tight cadence (e.g. every 15 minutes), or a webhook-received trigger if Intercom can post to a webhook.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:send-bugs-github-slack",
    category: "Support",
    title: "Send bugs to GitHub and Slack",
    description:
      "File bug-tagged reports as GitHub issues and alert the team on Slack.",
    connectors: ["github", "slack", "linear"],
    behavior: [
      "An issue is labeled bug",
      "Repro and impact packaged",
      "Sent to engineering",
    ],
    missingInfo:
      "Connectors: github, slack required; linear optional.\nSuggested trigger: Add a github-label-applied event trigger on the bug label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:spot-churn-risk-stripe-zendesk",
    category: "Support",
    title: "Spot churn risk in Stripe and Zendesk",
    description: "Flag accounts at risk of churn and draft a recovery email.",
    connectors: ["clerk", "stripe", "zendesk", "resend", "slack"],
    behavior: [
      "Zero scans accounts",
      "At-risk accounts flagged",
      "Recovery email drafted",
    ],
    missingInfo:
      "Connectors: clerk, stripe required; zendesk, resend, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Stripe and Zendesk have no native event trigger here, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:summarize-zendesk-tickets-daily",
    category: "Support",
    title: "Summarize Zendesk tickets daily",
    description:
      "Summarize the last day of Zendesk tickets and post it to Slack.",
    connectors: ["zendesk", "slack"],
    behavior: [
      "Zero reads the queue",
      "Grouped by severity and age",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: zendesk, slack required.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:daily-company-brief-slack",
    category: "CEO",
    title: "Post a daily company brief to Slack",
    description:
      "Pull product, growth, and revenue into a daily brief on Slack.",
    connectors: ["plausible", "slack", "clerk", "stripe", "github", "sentry"],
    behavior: [
      "Zero gathers the signals",
      "Assembled into a pulse",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: plausible, slack required; clerk, stripe, github, sentry optional.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:daily-industry-news-slack",
    category: "CEO",
    title: "Post daily industry news to Slack",
    description:
      "Round up the day's relevant industry news into a Slack brief.",
    connectors: ["exa", "slack"],
    behavior: [
      "Zero scans the news",
      "Distilled into a brief",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: exa, slack required.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:business-review-gamma",
    category: "CEO",
    title: "Build the business review in Gamma",
    description:
      "Turn the month's metrics into a business review deck in Gamma.",
    connectors: ["stripe", "gamma", "clerk"],
    behavior: [
      "Zero pulls the numbers",
      "Deck built in Gamma",
      "Ready to present",
    ],
    missingInfo:
      "Connectors: stripe, gamma required; clerk optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:highlight-key-emails-gmail",
    category: "CEO",
    title: "Highlight key emails in Gmail",
    description: "Surface the few emails that actually need your attention.",
    connectors: ["gmail", "slack"],
    behavior: [
      "Zero reads the inbox",
      "Priorities identified",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: gmail, slack required.\nSuggested trigger: Add a gmail-new-message event trigger, or a schedule trigger that runs a few times a day.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:investor-update-google-docs",
    category: "CEO",
    title: "Draft the investor update in Google Docs",
    description:
      "Assemble metrics and highlights into an investor update in Docs.",
    connectors: ["stripe", "google-docs", "google-sheets"],
    behavior: [
      "Zero gathers KPIs",
      "Update drafted",
      "Editable in Google Docs",
    ],
    missingInfo:
      "Connectors: stripe, google-docs required; google-sheets optional.\nSuggested trigger: Add a schedule trigger (e.g. monthly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:gmail-reconnect-reminders",
    category: "CEO",
    title: "Get Gmail reconnect reminders",
    description: "Surface important contacts you haven't emailed in a while.",
    connectors: ["gmail", "google-calendar", "slack"],
    behavior: [
      "Zero reviews your contacts",
      "Quiet relationships surfaced",
      "Openers suggested",
    ],
    missingInfo:
      "Connectors: gmail required; google-calendar, slack optional.\nSuggested trigger: Add a schedule trigger (e.g. weekly).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:clickup-slack-standup",
    category: "Operations",
    title: "ClickUp Slack standup",
    description:
      "Pull ClickUp tasks each morning and post a team standup summary to Slack.",
    connectors: ["clickup", "slack"],
    behavior: [
      "Create a daily scheduled workflow that reads selected ClickUp spaces, folders, lists, or assignees.",
      "Summarize active tasks, completed work, blockers, and overdue items by person or team.",
      "Keep the report compact enough for daily Slack consumption.",
      "Post the standup summary to the selected Slack channel.",
    ],
    missingInfo:
      "Connectors: clickup, slack required.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the ClickUp scope, schedule, timezone, grouping preference, and Slack channel.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sync-asana-projects-notion",
    category: "Operations",
    title: "Sync Asana projects to Notion",
    description: "Roll up Asana project status into a single board in Notion.",
    connectors: ["asana", "notion"],
    behavior: ["Zero reads Asana", "Rolled into one board", "Digest posted"],
    missingInfo:
      "Connectors: asana, notion required.\nSuggested trigger: Add a schedule trigger (e.g. every morning). Asana has no native event trigger, so poll on a cadence.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:meeting-notes-asana-tasks",
    category: "Operations",
    title: "Turn meeting notes into Asana tasks",
    description: "Turn meeting notes into assigned, due-dated tasks in Asana.",
    connectors: ["fireflies", "asana"],
    behavior: [
      "Zero reads the transcript",
      "Action items extracted",
      "Tasks created in Asana",
    ],
    missingInfo:
      "Connectors: fireflies, asana required.\nSuggested trigger: Add a google-meet-transcript-generated event trigger if you meet on Google Meet; otherwise a schedule trigger, since Fireflies has no native event trigger.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:file-gmail-invoices-drive",
    category: "Operations",
    title: "File Gmail invoices to Google Drive",
    description: "File invoice emails to Drive and log each one in a Sheet.",
    connectors: ["gmail", "google-drive", "google-sheets"],
    behavior: [
      "An invoice is labeled",
      "Filed to Google Drive",
      "Logged in a sheet",
    ],
    missingInfo:
      "Connectors: gmail, google-drive required; google-sheets optional.\nSuggested trigger: Add a gmail-label-applied event trigger on the label you use for invoices.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:onboard-new-hires-asana",
    category: "Operations",
    title: "Onboard new hires in Asana",
    description:
      "Create the onboarding task checklist for each new hire in Asana.",
    connectors: ["deel", "asana", "google-drive"],
    behavior: [
      "A new hire is added",
      "Checklist created in Asana",
      "Docs provisioned",
    ],
    missingInfo:
      "Connectors: deel, asana required; google-drive optional.\nSuggested trigger: Add a schedule trigger (e.g. daily). Deel has no native event trigger, so poll for new hires.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:chase-overdue-asana-tasks",
    category: "Operations",
    title: "Chase overdue Asana tasks",
    description: "Find overdue Asana tasks and nudge their owners on Slack.",
    connectors: ["asana", "slack"],
    behavior: ["Zero scans Asana", "Owners identified", "Nudges sent in Slack"],
    missingInfo:
      "Connectors: asana, slack required.\nSuggested trigger: Add a schedule trigger (e.g. every morning).\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:catch-calendar-conflicts",
    category: "Operations",
    title: "Catch Google Calendar conflicts",
    description: "Scan your calendar for double-bookings and alert you early.",
    connectors: ["google-calendar", "cal-com", "slack"],
    behavior: [
      "An event is created",
      "Checked for conflicts",
      "Conflict flagged in Slack",
    ],
    missingInfo:
      "Connectors: google-calendar required; cal-com, slack optional.\nSuggested trigger: Add a google-calendar-event-created event trigger, or a morning schedule that scans the day for conflicts.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:personal-weekly-digest",
    category: "Everyone",
    title: "Personal weekly digest",
    description:
      "Summarize GitHub, Gmail, and Calendar activity into one weekly Slack update.",
    connectors: ["github", "gmail", "google-calendar", "slack"],
    behavior: [
      "Create a weekly scheduled workflow for the selected owner.",
      "Collect recent pull requests, important inbox threads, and upcoming or completed calendar events.",
      "Group the digest into accomplishments, pending decisions, follow-ups, and upcoming commitments.",
      "Send the digest to the user's chosen Slack destination.",
    ],
    missingInfo:
      "Connectors: slack required; github, gmail, google-calendar optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the day/time, timezone, GitHub scope, Gmail filters, calendar scope, and Slack destination.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:morning-brief",
    category: "Everyone",
    title: "Morning brief",
    description:
      "Turn Gmail, Calendar, and Notion updates into a short daily plan in Slack.",
    connectors: ["gmail", "google-calendar", "notion", "slack"],
    behavior: [
      "Create a daily scheduled workflow that prepares a morning planning brief.",
      "Review important email, calendar events, and relevant Notion updates.",
      "Prioritize the day into meetings, decisions, follow-ups, and focus blocks.",
      "Post the brief to Slack or another destination the user chooses.",
    ],
    missingInfo:
      "Connectors: gmail, google-calendar, slack required; notion optional.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask only for the next missing detail among the schedule, timezone, Slack destination, Gmail scope, calendar scope, and Notion sources.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sort-gmail-draft-replies",
    category: "Everyone",
    title: "Sort Gmail and draft replies",
    description:
      "Sort your inbox and draft replies to the emails that need them.",
    connectors: ["gmail"],
    behavior: ["Zero reads new mail", "Sorted by urgency", "Replies drafted"],
    missingInfo:
      "Connectors: gmail required.\nSuggested trigger: Add a gmail-new-message event trigger so it runs on each new incoming email.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:research-calendar-meetings",
    category: "Everyone",
    title: "Research your calendar meetings",
    description:
      "Research the people you're meeting before each calendar event.",
    connectors: ["google-calendar", "exa", "slack"],
    behavior: [
      "A meeting is added",
      "Attendees researched",
      "Dossier delivered",
    ],
    missingInfo:
      "Connectors: google-calendar required; exa, slack optional.\nSuggested trigger: Add a google-calendar-event-created event trigger, or a morning schedule that scans the day's meetings.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:summarize-gmail-newsletters",
    category: "Everyone",
    title: "Summarize Gmail newsletters",
    description: "Digest the newsletters in your inbox into one short summary.",
    connectors: ["gmail", "slack"],
    behavior: [
      "Zero collects newsletters",
      "Digested into one summary",
      "Posted to Slack",
    ],
    missingInfo:
      "Connectors: gmail, slack required.\nSuggested trigger: Add a schedule trigger (e.g. weekly) to digest the newsletters, or a gmail-label-applied trigger on your newsletter label.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:meeting-recaps-slack",
    category: "Everyone",
    title: "Get meeting recaps in Slack",
    description:
      "Share a recap with decisions and action items after each meeting.",
    connectors: ["fireflies", "gmail", "slack"],
    behavior: ["Zero reads the transcript", "Recap written", "Sent to you"],
    missingInfo:
      "Connectors: fireflies required; gmail, slack optional.\nSuggested trigger: Add a google-meet-transcript-generated event trigger if you meet on Google Meet; otherwise a schedule trigger, since Fireflies has no native event trigger.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:flagged-gmail-todoist-tasks",
    category: "Everyone",
    title: "Turn flagged Gmail into Todoist tasks",
    description: "Turn the emails you flag into Todoist tasks automatically.",
    connectors: ["gmail", "todoist"],
    behavior: [
      "You flag an email",
      "Zero researches it",
      "Task filed in Todoist",
    ],
    missingInfo:
      "Connectors: gmail, todoist required.\nSuggested trigger: Add a gmail-label-applied event trigger on the label you apply to flag an email.\n\nCreate the workflow draft first. Before adding or enabling its automation, ask one short question for the next missing trigger or safety detail. Do not inspect connector setup until the workflow or trigger command reports that it is required.",
  }),
];

export function findWorkflowTemplateItem(
  id: string,
): WorkflowTemplateItem | undefined {
  return WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === id;
  });
}
