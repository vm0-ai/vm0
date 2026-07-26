// Shared presentational helpers for the workflow list, index, and detail views.
import type {
  GmailLabelAppliedEventConfig,
  GmailNewMessageEventConfig,
  ZeroWorkflowAutomationSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";

export function workflowTitle(workflow: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return workflow.displayName ?? workflow.name;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function agentLabel(workflow: {
  readonly agentDisplayName: string | null;
  readonly agentName: string | null;
  readonly agentId: string;
}): string {
  return workflow.agentDisplayName ?? workflow.agentName ?? workflow.agentId;
}

const WORKFLOW_INTERVAL_SECONDS_OPTIONS = [5, 15, 30, 60].map((minutes) => {
  return minutes * 60;
});

export function getWorkflowIntervalSecondOptions(
  currentSeconds?: number,
): readonly number[] {
  if (
    currentSeconds === undefined ||
    WORKFLOW_INTERVAL_SECONDS_OPTIONS.includes(currentSeconds)
  ) {
    return WORKFLOW_INTERVAL_SECONDS_OPTIONS;
  }
  return [...WORKFLOW_INTERVAL_SECONDS_OPTIONS, currentSeconds].sort((a, b) => {
    return a - b;
  });
}

export function formatWorkflowIntervalSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export function automationKindLabel(
  automation: ZeroWorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return "Schedule automation";
  }
  return automation.eventType === "webhook-received"
    ? "Webhook automation"
    : "Event automation";
}

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
export type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

export const GMAIL_TEXT_FIELDS: readonly {
  readonly field: GmailTextField;
  readonly label: string;
}[] = [
  { field: "from", label: "From" },
  { field: "subject", label: "Subject" },
  { field: "body", label: "Body" },
  { field: "to", label: "To" },
  { field: "cc", label: "Cc" },
];

function formTextValue(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildGmailNewMessageEventConfig(
  form: FormData,
  baseConfig?: GmailNewMessageEventConfig,
): GmailNewMessageEventConfig {
  const baseMatch = baseConfig?.match;
  const match: GmailMatchRules = {};
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const existing = baseMatch?.[field];
    const contains = formTextValue(form, `${field}Contains`);
    const doesNotContain = formTextValue(form, `${field}DoesNotContain`);
    const matcher: GmailTextMatcher = {};
    if (existing?.containsAny) {
      matcher.containsAny = existing.containsAny;
    }
    if (existing?.doesNotContainAny) {
      matcher.doesNotContainAny = existing.doesNotContainAny;
    }
    if (contains) {
      matcher.contains = contains;
    }
    if (doesNotContain) {
      matcher.doesNotContain = doesNotContain;
    }
    if (Object.keys(matcher).length > 0) {
      match[field] = matcher;
    }
  }
  return Object.keys(match).length > 0
    ? { provider: "gmail", event: "new_message", match }
    : { provider: "gmail", event: "new_message" };
}

export function buildGmailLabelAppliedEventConfig(
  form: FormData,
): GmailLabelAppliedEventConfig | null {
  const labelName = formTextValue(form, "labelName");
  if (!labelName) {
    return null;
  }
  return {
    provider: "gmail",
    event: "label_applied",
    labelName,
  };
}

function quote(value: string): string {
  return `"${value}"`;
}

function quoteList(values: readonly string[]): string {
  return values.map(quote).join(", ");
}

function textMatcherParts(
  field: GmailTextField,
  matcher: GmailTextMatcher,
): string[] {
  const parts: string[] = [];
  if (matcher.contains) {
    parts.push(`${field} contains ${quote(matcher.contains)}`);
  }
  if (matcher.containsAny) {
    parts.push(`${field} contains any of ${quoteList(matcher.containsAny)}`);
  }
  if (matcher.doesNotContain) {
    parts.push(`${field} does not contain ${quote(matcher.doesNotContain)}`);
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      `${field} does not contain any of ${quoteList(matcher.doesNotContainAny)}`,
    );
  }
  return parts;
}

export function formatGmailMatchSummary(
  config: GmailNewMessageEventConfig,
): string {
  const match = config.match;
  if (!match) {
    return "all inbound messages";
  }

  const parts: string[] = [];
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const matcher = match[field];
    if (matcher) {
      parts.push(...textMatcherParts(field, matcher));
    }
  }
  return parts.length > 0 ? parts.join("; ") : "all inbound messages";
}

export function gmailAutomationTitle(
  automation: ZeroWorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return automation.scheduleSummary;
  }
  if (automation.eventType === "gmail-label-applied") {
    return "Gmail label applied";
  }
  if (automation.eventType === "gmail-new-message") {
    return "Gmail new message";
  }
  if (automation.eventType === "github-label-applied") {
    return "GitHub label applied";
  }
  if (automation.eventType === "github-workflow-job-completed") {
    return "GitHub workflow job completed";
  }
  if (automation.eventType === "github-pull-request-review-submitted") {
    return "GitHub pull request review submitted";
  }
  if (automation.eventType === "github-deployment-status-created") {
    return "GitHub deployment status created";
  }
  if (automation.eventType === "github-issue-comment-created") {
    return "GitHub issue comment created";
  }
  if (automation.eventType === "github-workflow-run-completed") {
    return "GitHub workflow completed";
  }
  if (automation.eventType === "google-calendar-event-created") {
    return "Google Calendar event created";
  }
  if (automation.eventType === "google-calendar-event-updated") {
    return "Google Calendar event updated";
  }
  if (automation.eventType === "google-calendar-event-cancelled") {
    return "Google Calendar event cancelled";
  }
  if (automation.eventType === "google-meet-transcript-generated") {
    return "Google Meet transcript ready";
  }
  if (automation.eventType === "notion-child-page-created") {
    return "New Notion child page";
  }
  if (automation.eventType === "notion-database-item-created") {
    return "New Notion database item";
  }
  if (automation.eventType === "notion-page-content-updated") {
    return "Notion page content updated";
  }
  return "Webhook automation";
}

function githubAutomationSummary(
  automation: Extract<
    ZeroWorkflowAutomationSummary,
    { readonly kind: "event" }
  >,
): string | null {
  switch (automation.eventType) {
    case "github-label-applied": {
      return `Label ${quote(automation.eventConfig.labelName)}`;
    }
    case "github-workflow-run-completed":
    case "github-workflow-job-completed": {
      return (
        automation.eventConfig.filters.conclusions?.join(", ") ?? "Any result"
      );
    }
    case "github-pull-request-review-submitted": {
      return (
        automation.eventConfig.filters.reviewStates?.join(", ") ?? "Any review"
      );
    }
    case "github-deployment-status-created": {
      return (
        automation.eventConfig.filters.states?.join(", ") ??
        "Any deployment state"
      );
    }
    case "github-issue-comment-created": {
      return (
        automation.eventConfig.filters.commentPrefixes?.join(", ") ??
        "Any comment"
      );
    }
    default: {
      return null;
    }
  }
}

export function gmailAutomationSummary(
  automation: ZeroWorkflowAutomationSummary,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  if (automation.eventType === "gmail-label-applied") {
    return `Label ${quote(automation.eventConfig.labelName)}`;
  }
  if (automation.eventType === "gmail-new-message") {
    return formatGmailMatchSummary(automation.eventConfig);
  }
  const githubSummary = githubAutomationSummary(automation);
  if (githubSummary) {
    return githubSummary;
  }
  if (
    automation.eventType === "google-calendar-event-created" ||
    automation.eventType === "google-calendar-event-updated" ||
    automation.eventType === "google-calendar-event-cancelled"
  ) {
    return `Calendar ${quote(automation.eventConfig.calendarId)}`;
  }
  if (automation.eventType === "google-meet-transcript-generated") {
    return "Meetings you organize";
  }
  if (automation.eventType === "notion-child-page-created") {
    const title = automation.eventConfig.parentPage.title;
    return title ? `Parent page ${quote(title)}` : "Configured parent page";
  }
  if (automation.eventType === "notion-database-item-created") {
    const title = automation.eventConfig.dataSource.title;
    return title ? `Database ${quote(title)}` : "Configured database";
  }
  if (automation.eventType === "notion-page-content-updated") {
    if (automation.eventConfig.scope.type === "page") {
      const title = automation.eventConfig.scope.page.title;
      return title ? `Page ${quote(title)}` : "Configured page";
    }
    const title = automation.eventConfig.scope.dataSource.title;
    return title ? `Database ${quote(title)}` : "Configured database";
  }
  return null;
}

export function gmailMatcherDefaultValue(
  config: GmailNewMessageEventConfig,
  field: GmailTextField,
  key: "contains" | "doesNotContain",
): string {
  return config.match?.[field]?.[key] ?? "";
}
