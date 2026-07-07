import type { ConnectorType } from "@vm0/connectors/connectors";

export interface WorkflowTemplateItem {
  readonly id: `workflow-template:${string}`;
  readonly title: string;
  readonly description: string;
  readonly connectors: readonly ConnectorType[];
  readonly promptGuidance: string;
}

function defineWorkflowTemplate(args: {
  readonly id: WorkflowTemplateItem["id"];
  readonly title: string;
  readonly description: string;
  readonly connectors: readonly ConnectorType[];
  readonly behavior: readonly string[];
  readonly missingInfo: string;
}): WorkflowTemplateItem {
  return {
    id: args.id,
    title: args.title,
    description: args.description,
    connectors: args.connectors,
    promptGuidance: [
      "# Workflow Template Context",
      "",
      `The user selected the built-in workflow template: ${args.title} (${args.id}).`,
      "Use the workflow-setup skill to help the user create or remix a workflow for this agent.",
      "Do not execute an existing workflow. This template is only context for creating or updating a workflow.",
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
      "Before creating anything, ask for the Gmail label name, handling rules, and final action if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:daily-standup-report",
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
      "Before creating anything, ask for the schedule, timezone, Slack channel, metric scope, and any required report sections if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:personal-weekly-digest",
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
      "Before creating anything, ask for the day/time, timezone, GitHub scope, Gmail filters, calendar scope, and Slack destination if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:morning-brief",
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
      "Before creating anything, ask for the schedule, timezone, Slack destination, Gmail scope, calendar scope, and Notion sources if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:github-pr-summarizer",
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
      "Before creating anything, ask for the repositories, cadence, timezone, Notion destination, Slack destination, and grouping rules if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:sentry-issue-digest",
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
      "Before creating anything, ask for the Sentry projects, severity threshold, schedule, timezone, and Slack channel if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:vercel-deploy-digest",
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
      "Before creating anything, ask for the Vercel projects, GitHub repositories, alert rules, cadence, and Slack channel if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:revenuecat-subscription-digest",
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
      "Before creating anything, ask for the RevenueCat project, schedule, timezone, Sheets destination, Slack channel, and alert thresholds if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:support-ticket-router",
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
      "Before creating anything, ask for the inbox or label, triage rules, Notion database, Slack channel, and escalation criteria if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:feedback-router",
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
      "Before creating anything, ask for the Slack channel, Notion database, taxonomy, owner mapping, and run cadence if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:competitive-intel-monitor",
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
      "Before creating anything, ask for competitor URLs, cadence, timezone, Notion destination, Slack channel, and alert criteria if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:x-brand-monitor",
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
      "Before creating anything, ask for the keywords or accounts, cadence, Notion database, Slack channel, and alert thresholds if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:salesforce-pipeline-digest",
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
      "Before creating anything, ask for the Salesforce object scope, cadence, timezone, Slack channel, and pipeline rules if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:zendesk-knowledge-base",
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
      "Before creating anything, ask for the Zendesk scope, cadence, Notion destination, Slack channel, and publishing/review rules if they are missing.",
  }),
  defineWorkflowTemplate({
    id: "workflow-template:clickup-slack-standup",
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
      "Before creating anything, ask for the ClickUp scope, schedule, timezone, grouping preference, and Slack channel if they are missing.",
  }),
];

export function findWorkflowTemplateItem(
  id: string,
): WorkflowTemplateItem | undefined {
  return WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === id;
  });
}
