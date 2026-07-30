import chalk from "chalk";
import type { GmailNewMessageEventConfig } from "@vm0/api-contracts/contracts/zero-workflows";
import type { ZeroWorkflowAutomationSummary } from "../../../../lib/api";
import { formatRelativeTime } from "../../../../lib/domain/relative-time";
import { formatDurationSeconds } from "../../shared/duration";

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

export interface WorkflowAutomationThreadModel {
  readonly id: string;
  readonly label: string;
}

interface WorkflowAutomationDetailsOptions {
  readonly workflowRef?: string;
  readonly workflowId?: string;
  readonly threadModel?: WorkflowAutomationThreadModel;
}

const GMAIL_TEXT_FIELDS: readonly GmailTextField[] = [
  "from",
  "subject",
  "body",
  "to",
  "cc",
];

type WorkflowWebhookAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;
type WorkflowNotionChildPageAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "notion-child-page-created" }
>;
type WorkflowNotionDatabaseItemAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType: "notion-database-item-created";
  }
>;
type WorkflowNotionPageContentUpdatedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType: "notion-page-content-updated";
  }
>;
function chatRunFinishedKindLabel(eventConfig: {
  readonly chatThreadId: string;
  readonly runStatuses?: readonly string[];
  readonly outputPattern?: string;
}): string {
  const statuses = eventConfig.runStatuses?.join(",") ?? "any";
  const pattern = eventConfig.outputPattern
    ? ` matching "${eventConfig.outputPattern}"`
    : "";
  return `Chat run finished (${statuses})${pattern}: ${eventConfig.chatThreadId}`;
}

type WorkflowStrapiAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "strapi-entry-published" }
>;

function isWebhookAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is WorkflowWebhookAutomationSummary {
  return (
    automation.kind === "event" && automation.eventType === "webhook-received"
  );
}

function isNotionChildPageAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is WorkflowNotionChildPageAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "notion-child-page-created"
  );
}

function isNotionDatabaseItemAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is WorkflowNotionDatabaseItemAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "notion-database-item-created"
  );
}

function isNotionPageContentUpdatedAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is WorkflowNotionPageContentUpdatedAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "notion-page-content-updated"
  );
}

function formatStrapiAutomation(
  automation: WorkflowStrapiAutomationSummary,
): string {
  const contentType =
    automation.eventConfig.contentTypeUid ?? "any content type";
  const locale = automation.eventConfig.locale ?? "any locale";
  return `Strapi entry published: ${contentType}, ${locale}`;
}

function isGoogleCalendarAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is Extract<
  ZeroWorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType:
      | "google-calendar-event-created"
      | "google-calendar-event-updated"
      | "google-calendar-event-cancelled";
  }
> {
  return (
    automation.kind === "event" &&
    (automation.eventType === "google-calendar-event-created" ||
      automation.eventType === "google-calendar-event-updated" ||
      automation.eventType === "google-calendar-event-cancelled")
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
  const parts: string[] = config.threadId
    ? [`Thread ID is ${quote(config.threadId)}`]
    : [];
  const match = config.match;
  if (match) {
    for (const field of GMAIL_TEXT_FIELDS) {
      const matcher = match[field];
      if (matcher) {
        parts.push(...textMatcherParts(field, matcher));
      }
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

function formatWebhookAutomationEntry(
  automation: WorkflowWebhookAutomationSummary,
): string {
  return `Webhook: ${automation.webhookUrl ?? "hidden"}`;
}

function formatNotionParentPage(
  automation: WorkflowNotionChildPageAutomationSummary,
): string {
  return (
    automation.eventConfig.parentPage.title ??
    automation.eventConfig.parentPage.url
  );
}

function formatNotionDatabase(
  automation: WorkflowNotionDatabaseItemAutomationSummary,
): string {
  return (
    automation.eventConfig.dataSource.title ??
    automation.eventConfig.dataSource.url
  );
}

function formatNotionContentUpdatedScope(
  automation: WorkflowNotionPageContentUpdatedAutomationSummary,
): string {
  return automation.eventConfig.scope.type === "page"
    ? (automation.eventConfig.scope.page.title ??
        automation.eventConfig.scope.page.url)
    : (automation.eventConfig.scope.dataSource.title ??
        automation.eventConfig.scope.dataSource.url);
}

function formatNotionContentUpdatedScopeUrl(
  automation: WorkflowNotionPageContentUpdatedAutomationSummary,
): string {
  return automation.eventConfig.scope.type === "page"
    ? automation.eventConfig.scope.page.url
    : automation.eventConfig.scope.dataSource.url;
}

function formatWorkflowAutomationEntry(
  automation: ZeroWorkflowAutomationSummary,
): string {
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-new-message"
  ) {
    return `Gmail new message: ${formatGmailMatchSummary(automation.eventConfig)}`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-label-applied"
  ) {
    return `Gmail label applied: ${quote(automation.eventConfig.labelName)}`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "github-label-applied"
  ) {
    return `GitHub label applied: ${quote(automation.eventConfig.labelName)} (${formatGithubSubject(
      automation.eventConfig.filters.subject,
    )}, actor ${automation.eventConfig.filters.actor.type})`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "google-calendar-event-created"
  ) {
    return `Google Calendar event created: ${automation.eventConfig.calendarId}`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "google-calendar-event-updated"
  ) {
    return `Google Calendar event updated: ${automation.eventConfig.calendarId}`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "google-calendar-event-cancelled"
  ) {
    return `Google Calendar event cancelled: ${automation.eventConfig.calendarId}`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "google-meet-transcript-generated"
  ) {
    return "Google Meet transcript ready: meetings you organize";
  }
  if (isWebhookAutomation(automation)) {
    return formatWebhookAutomationEntry(automation);
  }

  if (automation.kind !== "schedule") {
    return workflowAutomationKindLabel(automation);
  }

  const { schedule } = automation;
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

function workflowAutomationKindLabel(
  automation: ZeroWorkflowAutomationSummary,
): string {
  if (automation.kind !== "event") {
    return formatWorkflowAutomationEntry(automation);
  }
  switch (automation.eventType) {
    case "chat-run-finished":
      return chatRunFinishedKindLabel(automation.eventConfig);
    case "gmail-new-message":
      return "Gmail new message";
    case "gmail-label-applied":
      return "Gmail label applied";
    case "github-label-applied":
      return "GitHub label applied";
    case "github-deployment-status-created":
      return "GitHub deployment status created";
    case "github-issue-comment-created":
      return "GitHub issue comment created";
    case "github-pull-request-review-submitted":
      return "GitHub pull request review submitted";
    case "github-workflow-job-completed":
      return "GitHub workflow job completed";
    case "github-workflow-run-completed":
      return "GitHub workflow completed";
    case "google-calendar-event-created":
      return "Google Calendar event created";
    case "google-calendar-event-updated":
      return "Google Calendar event updated";
    case "google-calendar-event-cancelled":
      return "Google Calendar event cancelled";
    case "google-meet-transcript-generated":
      return "Google Meet transcript ready";
    case "notion-child-page-created":
      return `New Notion child page: ${formatNotionParentPage(automation)}`;
    case "notion-database-item-created":
      return `New Notion database item: ${formatNotionDatabase(automation)}`;
    case "notion-page-content-updated":
      return `Notion page content updated: ${formatNotionContentUpdatedScope(automation)}`;
    case "strapi-entry-published":
      return formatStrapiAutomation(automation);
    case "webhook-received":
      return "Webhook";
  }
}

function signedCurlExample(
  automation: WorkflowWebhookAutomationSummary,
): string {
  const secret = automation.webhookSecret ?? "<signing-secret>";
  const webhookUrl = automation.webhookUrl ?? "<webhook-url>";
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

export function printWorkflowAutomationsTable(
  automations: readonly ZeroWorkflowAutomationSummary[],
): void {
  const idWidth = Math.max(
    2,
    ...automations.map((automation) => {
      return automation.id.length;
    }),
  );
  const scheduleWidth = Math.max(
    7,
    ...automations.map((automation) => {
      return formatWorkflowAutomationEntry(automation).length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "ID".padEnd(idWidth),
        "STATUS".padEnd(8),
        "AUTOMATION".padEnd(scheduleWidth),
        "NEXT RUN",
      ].join("  "),
    ),
  );

  for (const automation of automations) {
    const status = automation.enabled
      ? chalk.green("enabled")
      : chalk.yellow("disabled");
    console.log(
      [
        automation.id.padEnd(idWidth),
        status.padEnd(8 + (automation.enabled ? 0 : 2)),
        formatWorkflowAutomationEntry(automation).padEnd(scheduleWidth),
        formatRunTime(automation.nextRunAt),
      ].join("  "),
    );
  }
}

function printGithubFilters(automation: ZeroWorkflowAutomationSummary): void {
  if (automation.kind !== "event") {
    return;
  }
  const printFilter = (
    label: string,
    values: readonly string[] | undefined,
  ) => {
    console.log(`${`${label}:`.padEnd(14)}${values?.join(", ") ?? "any"}`);
  };
  switch (automation.eventType) {
    case "github-workflow-run-completed": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Workflows", filters.workflows);
      printFilter("Conclusions", filters.conclusions);
      printFilter("Branches", filters.branches);
      printFilter("Events", filters.events);
      printFilter("Actors", filters.actors);
      return;
    }
    case "github-workflow-job-completed": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Workflows", filters.workflows);
      printFilter("Jobs", filters.jobs);
      printFilter("Conclusions", filters.conclusions);
      printFilter("Branches", filters.branches);
      printFilter("Runner labels", filters.runnerLabels);
      printFilter("Runner groups", filters.runnerGroups);
      return;
    }
    case "github-pull-request-review-submitted": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Review states", filters.reviewStates);
      printFilter("Base branches", filters.baseBranches);
      printFilter("Head branches", filters.headBranches);
      printFilter("Authors", filters.trustedAuthors);
      return;
    }
    case "github-deployment-status-created": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Environments", filters.environments);
      printFilter("States", filters.states);
      printFilter("Refs", filters.refs);
      console.log(
        `${"Production:".padEnd(14)}${
          filters.productionEnvironment === undefined
            ? "any"
            : String(filters.productionEnvironment)
        }`,
      );
      printFilter("Creators", filters.creators);
      printFilter("Apps", filters.apps);
      return;
    }
    case "github-issue-comment-created": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      console.log(
        `${"Subject:".padEnd(14)}${formatGithubSubject(filters.subject)}`,
      );
      printFilter("Authors", filters.trustedAuthors);
      printFilter("Prefixes", filters.commentPrefixes);
      return;
    }
    default: {
      return;
    }
  }
}

function printCommand(lines: readonly string[]): void {
  for (const line of lines) {
    console.log(chalk.cyan(`    ${line}`));
  }
}

function automationUpdateGuidance(automation: ZeroWorkflowAutomationSummary): {
  readonly label: string;
  readonly command: readonly string[];
} {
  if (automation.kind !== "schedule") {
    return {
      label: "Edit automation",
      command: ["zero workflow automation update --help"],
    };
  }

  switch (automation.schedule.type) {
    case "cron":
      return {
        label: "Change schedule",
        command: [
          "zero workflow automation update \\",
          `  ${automation.id} \\`,
          '  --expr "<cron-expression>" -z <timezone>',
        ],
      };
    case "loop":
      return {
        label: "Change interval",
        command: [
          "zero workflow automation update \\",
          `  ${automation.id} \\`,
          "  --every <duration>",
        ],
      };
    case "once":
      return {
        label: "Change run time",
        command: [
          "zero workflow automation update \\",
          `  ${automation.id} \\`,
          '  --at "<iso-time>" -z <timezone>',
        ],
      };
  }
}

function printManagementCommands(
  automation: ZeroWorkflowAutomationSummary,
  options: WorkflowAutomationDetailsOptions,
): void {
  if (!options.workflowId) {
    return;
  }

  const update = automationUpdateGuidance(automation);
  const statusAction = automation.enabled
    ? {
        label: "Pause automation",
        command: "disable",
      }
    : {
        label: "Resume automation",
        command: "enable",
      };

  console.log("");
  console.log(chalk.bold("Manage with Zero CLI:"));
  console.log("  Edit workflow:");
  printCommand([
    `zero workflow edit ${options.workflowId} \\`,
    "  --instruction-file <path>",
  ]);
  console.log("");
  console.log(`  ${update.label}:`);
  printCommand(update.command);
  console.log("");
  console.log(`  ${statusAction.label}:`);
  printCommand([
    `zero workflow automation ${statusAction.command} \\`,
    `  ${automation.id}`,
  ]);
  console.log("");
  console.log("  More automation options:");
  printCommand(["zero workflow automation --help"]);

  if (!automation.chatThreadId || !options.threadModel) {
    return;
  }

  console.log("");
  console.log(chalk.bold("About model selection:"));
  console.log(
    "  The selected model affects run behavior, output quality, and cost.",
  );
  console.log(
    "  Automations do not store a separate model. All automations on this workflow",
  );
  console.log(
    "  share one chat thread and use that thread's model. Changing the thread model",
  );
  console.log("  changes the model used by all of them.");
  console.log("");
  console.log(chalk.bold("Model commands:"));
  console.log("  Show:");
  printCommand(["zero chat model \\", `  --thread ${automation.chatThreadId}`]);
  console.log("");
  console.log("  Change:");
  printCommand([
    "zero chat model \\",
    `  --thread ${automation.chatThreadId} \\`,
    "  <model-id>",
  ]);
  console.log("");
  console.log("  Options:");
  printCommand(["zero model list"]);
}

export function printWorkflowAutomationThreadModel(
  model: WorkflowAutomationThreadModel | undefined,
): void {
  if (!model) {
    return;
  }
  console.log(
    `${"Thread model:".padEnd(14)}${model.label} ${chalk.dim(`(${model.id})`)}`,
  );
}

export function printWorkflowAutomationDetails(
  automation: ZeroWorkflowAutomationSummary,
  options: WorkflowAutomationDetailsOptions = {},
): void {
  const status = automation.enabled
    ? chalk.green("enabled")
    : chalk.yellow("disabled");

  console.log(`${"Kind:".padEnd(14)}${automation.kind}`);
  console.log(`${"ID:".padEnd(14)}${automation.id}`);
  if (options?.workflowRef) {
    console.log(`${"Workflow:".padEnd(14)}${options.workflowRef}`);
  }
  console.log(`${"Status:".padEnd(14)}${status}`);
  console.log(
    `${"Automation:".padEnd(14)}${workflowAutomationKindLabel(automation)}`,
  );
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-new-message"
  ) {
    console.log(
      `${"Match:".padEnd(14)}${formatGmailMatchSummary(automation.eventConfig)}`,
    );
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-label-applied"
  ) {
    console.log(`${"Label:".padEnd(14)}${automation.eventConfig.labelName}`);
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "github-label-applied"
  ) {
    console.log(`${"Label:".padEnd(14)}${automation.eventConfig.labelName}`);
    console.log(
      `${"Subject:".padEnd(14)}${formatGithubSubject(
        automation.eventConfig.filters.subject,
      )}`,
    );
    console.log(
      `${"Actor:".padEnd(14)}${automation.eventConfig.filters.actor.type}`,
    );
  }
  printGithubFilters(automation);
  if (isGoogleCalendarAutomation(automation)) {
    console.log(
      `${"Calendar:".padEnd(14)}${automation.eventConfig.calendarId}`,
    );
  }
  if (isNotionChildPageAutomation(automation)) {
    console.log(
      `${"Parent page:".padEnd(14)}${formatNotionParentPage(automation)}`,
    );
    console.log(
      `${"Parent URL:".padEnd(14)}${automation.eventConfig.parentPage.url}`,
    );
  }
  if (isNotionDatabaseItemAutomation(automation)) {
    console.log(`${"Database:".padEnd(14)}${formatNotionDatabase(automation)}`);
    console.log(
      `${"Database URL:".padEnd(14)}${automation.eventConfig.dataSource.url}`,
    );
  }
  if (isNotionPageContentUpdatedAutomation(automation)) {
    const scopeLabel =
      automation.eventConfig.scope.type === "page" ? "Page" : "Database";
    console.log(`${"Scope:".padEnd(14)}${scopeLabel}`);
    console.log(
      `${`${scopeLabel}:`.padEnd(14)}${formatNotionContentUpdatedScope(automation)}`,
    );
    console.log(
      `${`${scopeLabel} URL:`.padEnd(14)}${formatNotionContentUpdatedScopeUrl(automation)}`,
    );
  }
  if (isWebhookAutomation(automation)) {
    console.log(
      `${"Webhook URL:".padEnd(14)}${automation.webhookUrl ?? "hidden"}`,
    );
    console.log(
      `${"Secret:".padEnd(14)}${chalk.dim(`ends with ${automation.secretLastFour}`)}`,
    );
    console.log(
      `${"Last received:".padEnd(14)}${formatRunTime(automation.lastReceivedAt)}`,
    );
    if (automation.webhookSecret) {
      console.log(
        `${"Signing key:".padEnd(14)}${automation.webhookSecret} ${chalk.dim(
          "(shown only once)",
        )}`,
      );
      console.log("");
      console.log(chalk.bold("Signed curl example:"));
      console.log(signedCurlExample(automation));
    }
  }
  console.log(`${"Owner:".padEnd(14)}${automation.ownerUserId}`);
  console.log(
    `${"Chat thread:".padEnd(14)}${automation.chatThreadId ?? chalk.dim("-")}`,
  );
  printWorkflowAutomationThreadModel(options.threadModel);
  console.log(
    `${"Next run:".padEnd(14)}${formatRunTime(automation.nextRunAt)}`,
  );
  console.log(
    `${"Last run:".padEnd(14)}${formatRunTime(automation.lastRunAt)}`,
  );
  printManagementCommands(automation, options);
}
