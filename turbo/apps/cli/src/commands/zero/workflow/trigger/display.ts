import chalk from "chalk";
import type {
  GmailNewMessageEventConfig,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { formatRelativeTime } from "../../../../lib/domain/schedule-utils";
import { formatDurationSeconds } from "../../automation/duration";

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
  if (match.snippet || match.labels || match.hasAttachment !== undefined) {
    parts.push("custom match rules");
  }
  return parts.length > 0 ? parts.join("; ") : "all inbound messages";
}

function formatWorkflowTriggerEntry(
  trigger: ZeroWorkflowTriggerSummary,
): string {
  if (trigger.kind === "event") {
    return `Gmail new message: ${formatGmailMatchSummary(trigger.eventConfig)}`;
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
  console.log(
    `${"Trigger:".padEnd(14)}${
      trigger.kind === "event"
        ? "Gmail new message"
        : formatWorkflowTriggerEntry(trigger)
    }`,
  );
  if (trigger.kind === "event") {
    console.log(
      `${"Match:".padEnd(14)}${formatGmailMatchSummary(trigger.eventConfig)}`,
    );
  }
  console.log(`${"Owner:".padEnd(14)}${trigger.ownerUserId}`);
  console.log(
    `${"Chat thread:".padEnd(14)}${trigger.chatThreadId ?? chalk.dim("-")}`,
  );
  console.log(`${"Next run:".padEnd(14)}${formatRunTime(trigger.nextRunAt)}`);
  console.log(`${"Last run:".padEnd(14)}${formatRunTime(trigger.lastRunAt)}`);
}
