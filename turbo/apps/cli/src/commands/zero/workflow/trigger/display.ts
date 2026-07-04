import chalk from "chalk";
import type {
  GmailNewMessageEventConfig,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { formatRelativeTime } from "../../../../lib/domain/schedule-utils";
import { formatDurationSeconds } from "../../shared/duration";

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

const GMAIL_TEXT_FIELDS: readonly GmailTextField[] = [
  "from",
  "subject",
  "body",
  "to",
  "cc",
];

type WorkflowWebhookTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;

function isWebhookTrigger(
  trigger: ZeroWorkflowTriggerSummary,
): trigger is WorkflowWebhookTriggerSummary {
  return trigger.kind === "event" && trigger.eventType === "webhook-received";
}

function isGoogleCalendarTrigger(
  trigger: ZeroWorkflowTriggerSummary,
): trigger is Extract<
  ZeroWorkflowTriggerSummary,
  {
    readonly kind: "event";
    readonly eventType:
      | "google-calendar-event-created"
      | "google-calendar-event-updated"
      | "google-calendar-event-cancelled";
  }
> {
  return (
    trigger.kind === "event" &&
    (trigger.eventType === "google-calendar-event-created" ||
      trigger.eventType === "google-calendar-event-updated" ||
      trigger.eventType === "google-calendar-event-cancelled")
  );
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

function formatGmailMatchSummary(config: GmailNewMessageEventConfig): string {
  const match = config.match;
  if (!match) {
    return "all inbound messages";
  }

  const parts: string[] = [];
  for (const field of GMAIL_TEXT_FIELDS) {
    const matcher = match[field];
    if (matcher) {
      parts.push(...textMatcherParts(field, matcher));
    }
  }
  return parts.length > 0 ? parts.join("; ") : "all inbound messages";
}

function formatGithubSubject(subject: string): string {
  if (subject === "pull_requests") {
    return "pull requests";
  }
  return subject;
}

function formatWebhookTriggerEntry(
  trigger: WorkflowWebhookTriggerSummary,
): string {
  return `Webhook: ${trigger.webhookUrl ?? "hidden"}`;
}

function formatWorkflowTriggerEntry(
  trigger: ZeroWorkflowTriggerSummary,
): string {
  if (trigger.kind === "event" && trigger.eventType === "gmail-new-message") {
    return `Gmail new message: ${formatGmailMatchSummary(trigger.eventConfig)}`;
  }
  if (trigger.kind === "event" && trigger.eventType === "gmail-label-applied") {
    return `Gmail label applied: ${quote(trigger.eventConfig.labelName)}`;
  }
  if (
    trigger.kind === "event" &&
    trigger.eventType === "github-label-applied"
  ) {
    return `GitHub label applied: ${quote(trigger.eventConfig.labelName)} (${formatGithubSubject(
      trigger.eventConfig.filters.subject,
    )}, actor ${trigger.eventConfig.filters.actor.type})`;
  }
  if (
    trigger.kind === "event" &&
    trigger.eventType === "google-calendar-event-created"
  ) {
    return `Google Calendar event created: ${trigger.eventConfig.calendarId}`;
  }
  if (
    trigger.kind === "event" &&
    trigger.eventType === "google-calendar-event-updated"
  ) {
    return `Google Calendar event updated: ${trigger.eventConfig.calendarId}`;
  }
  if (
    trigger.kind === "event" &&
    trigger.eventType === "google-calendar-event-cancelled"
  ) {
    return `Google Calendar event cancelled: ${trigger.eventConfig.calendarId}`;
  }
  if (
    trigger.kind === "event" &&
    trigger.eventType === "google-meet-transcript-generated"
  ) {
    return "Google Meet transcript ready: meetings you organize";
  }
  if (isWebhookTrigger(trigger)) {
    return formatWebhookTriggerEntry(trigger);
  }

  if (trigger.kind !== "schedule") {
    return workflowTriggerKindLabel(trigger);
  }

  const { schedule } = trigger;
  switch (schedule.type) {
    case "cron":
      return `${schedule.cronExpression} (${schedule.timezone})`;
    case "once":
      return `at ${schedule.atTime} (${schedule.timezone})`;
    case "loop":
      return `every ${formatDurationSeconds(schedule.intervalSeconds)}`;
  }
}

function formatRunTime(value: string | null): string {
  return value ? formatRelativeTime(value) : chalk.dim("-");
}

function workflowTriggerKindLabel(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind !== "event") {
    return formatWorkflowTriggerEntry(trigger);
  }
  switch (trigger.eventType) {
    case "gmail-new-message":
      return "Gmail new message";
    case "gmail-label-applied":
      return "Gmail label applied";
    case "github-label-applied":
      return "GitHub label applied";
    case "google-calendar-event-created":
      return "Google Calendar event created";
    case "google-calendar-event-updated":
      return "Google Calendar event updated";
    case "google-calendar-event-cancelled":
      return "Google Calendar event cancelled";
    case "google-meet-transcript-generated":
      return "Google Meet transcript ready";
    case "webhook-received":
      return "Webhook";
  }
}

function signedCurlExample(trigger: WorkflowWebhookTriggerSummary): string {
  const secret = trigger.webhookSecret ?? "<signing-secret>";
  const webhookUrl = trigger.webhookUrl ?? "<webhook-url>";
  return [
    `BODY='{"hello":"world"}'`,
    "TIMESTAMP=$(date +%s)",
    `SIGNATURE=$(printf "%s.%s" "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "${secret}" -hex | awk '{print $2}')`,
    `curl -X POST "${webhookUrl}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "X-VM0-Timestamp: $TIMESTAMP" \\',
    '  -H "X-VM0-Signature: $SIGNATURE" \\',
    '  --data "$BODY"',
  ].join("\n");
}

export function printWorkflowTriggersTable(
  triggers: readonly ZeroWorkflowTriggerSummary[],
): void {
  const idWidth = Math.max(
    2,
    ...triggers.map((trigger) => {
      return trigger.id.length;
    }),
  );
  const scheduleWidth = Math.max(
    7,
    ...triggers.map((trigger) => {
      return formatWorkflowTriggerEntry(trigger).length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "ID".padEnd(idWidth),
        "STATUS".padEnd(8),
        "TRIGGER".padEnd(scheduleWidth),
        "NEXT RUN",
      ].join("  "),
    ),
  );

  for (const trigger of triggers) {
    const status = trigger.enabled
      ? chalk.green("enabled")
      : chalk.yellow("disabled");
    console.log(
      [
        trigger.id.padEnd(idWidth),
        status.padEnd(8 + (trigger.enabled ? 0 : 2)),
        formatWorkflowTriggerEntry(trigger).padEnd(scheduleWidth),
        formatRunTime(trigger.nextRunAt),
      ].join("  "),
    );
  }
}

export function printWorkflowTriggerDetails(
  trigger: ZeroWorkflowTriggerSummary,
  options?: { readonly workflowRef?: string },
): void {
  const status = trigger.enabled
    ? chalk.green("enabled")
    : chalk.yellow("disabled");

  console.log(`${"Kind:".padEnd(14)}${trigger.kind}`);
  console.log(`${"ID:".padEnd(14)}${trigger.id}`);
  if (options?.workflowRef) {
    console.log(`${"Workflow:".padEnd(14)}${options.workflowRef}`);
  }
  console.log(`${"Status:".padEnd(14)}${status}`);
  console.log(`${"Trigger:".padEnd(14)}${workflowTriggerKindLabel(trigger)}`);
  if (trigger.kind === "event" && trigger.eventType === "gmail-new-message") {
    console.log(
      `${"Match:".padEnd(14)}${formatGmailMatchSummary(trigger.eventConfig)}`,
    );
  }
  if (trigger.kind === "event" && trigger.eventType === "gmail-label-applied") {
    console.log(`${"Label:".padEnd(14)}${trigger.eventConfig.labelName}`);
  }
  if (
    trigger.kind === "event" &&
    trigger.eventType === "github-label-applied"
  ) {
    console.log(`${"Label:".padEnd(14)}${trigger.eventConfig.labelName}`);
    console.log(
      `${"Subject:".padEnd(14)}${formatGithubSubject(
        trigger.eventConfig.filters.subject,
      )}`,
    );
    console.log(
      `${"Actor:".padEnd(14)}${trigger.eventConfig.filters.actor.type}`,
    );
  }
  if (isGoogleCalendarTrigger(trigger)) {
    console.log(`${"Calendar:".padEnd(14)}${trigger.eventConfig.calendarId}`);
  }
  if (isWebhookTrigger(trigger)) {
    console.log(
      `${"Webhook URL:".padEnd(14)}${trigger.webhookUrl ?? "hidden"}`,
    );
    console.log(
      `${"Secret:".padEnd(14)}${chalk.dim(`ends with ${trigger.secretLastFour}`)}`,
    );
    console.log(
      `${"Last received:".padEnd(14)}${formatRunTime(trigger.lastReceivedAt)}`,
    );
    if (trigger.webhookSecret) {
      console.log(
        `${"Signing key:".padEnd(14)}${trigger.webhookSecret} ${chalk.dim(
          "(shown only once)",
        )}`,
      );
      console.log("");
      console.log(chalk.bold("Signed curl example:"));
      console.log(signedCurlExample(trigger));
    }
  }
  console.log(`${"Owner:".padEnd(14)}${trigger.ownerUserId}`);
  console.log(
    `${"Chat thread:".padEnd(14)}${trigger.chatThreadId ?? chalk.dim("-")}`,
  );
  console.log(`${"Next run:".padEnd(14)}${formatRunTime(trigger.nextRunAt)}`);
  console.log(`${"Last run:".padEnd(14)}${formatRunTime(trigger.lastRunAt)}`);
}
