import { Command } from "commander";
import chalk from "chalk";
import type {
  ChatRunFinishedRunStatus,
  GithubDeploymentState,
  GithubLabelAppliedSubjectFilter,
  GithubPullRequestReviewState,
  GithubWorkflowRunConclusion,
  ZeroWorkflowSchedule,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  type ZeroWorkflowAutomationCreateRequest,
  type ZeroWorkflowAutomationSummary,
  type ZeroWorkflowAutomationUpdateRequest,
  createWorkflowAutomation,
  deleteWorkflowAutomation,
  disableWorkflowAutomation,
  enableWorkflowAutomation,
  getZeroChatThread,
  getWorkflowAutomation,
  listWorkspaceWorkflowAutomations,
  listZeroModelPolicies,
  listWorkflowAutomations,
  updateWorkflowAutomation,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { decodeZeroTokenPayload } from "../../../../lib/api/zero-token";
import { parseDurationSeconds } from "../../shared/duration";
import {
  resolveWorkflowRef,
  type WorkflowRefOptions,
} from "../resolve-workflow-ref";
import {
  printWorkflowAutomationDetails,
  printWorkflowAutomationThreadModel,
  printWorkflowAutomationsTable,
  type WorkflowAutomationThreadModel,
} from "./display";
import {
  buildGmailLabelAppliedEventConfig,
  buildGmailNewMessageEventConfig,
  hasGmailLabelOption,
  hasGmailAutomationOptions,
  type GmailAutomationOptions,
} from "./gmail-config";

interface AddOptions extends GmailAutomationOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
  readonly agent?: string;
  readonly subject?: string;
  readonly actor?: string;
  readonly repository?: string;
  readonly workflow?: string;
  readonly job?: string;
  readonly conclusion?: string;
  readonly branch?: string;
  readonly triggeringEvent?: string;
  readonly runnerLabel?: string;
  readonly runnerGroup?: string;
  readonly reviewState?: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly trustedAuthor?: string;
  readonly environment?: string;
  readonly deploymentState?: string;
  readonly ref?: string;
  readonly productionEnvironment?: string;
  readonly creator?: string;
  readonly app?: string;
  readonly commentPrefix?: string;
  readonly calendarId?: string;
  readonly pageUrl?: string;
  readonly parentPageUrl?: string;
  readonly databaseUrl?: string;
  readonly integrationId?: string;
  readonly contentTypeUid?: string;
  readonly locale?: string;
  readonly chatThreadId?: string;
  readonly runStatus?: string;
  readonly outputPattern?: string;
}

interface UpdateOptions extends GmailAutomationOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
  readonly subject?: string;
  readonly actor?: string;
  readonly repository?: string;
  readonly workflow?: string;
  readonly job?: string;
  readonly conclusion?: string;
  readonly branch?: string;
  readonly triggeringEvent?: string;
  readonly runnerLabel?: string;
  readonly runnerGroup?: string;
  readonly reviewState?: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly trustedAuthor?: string;
  readonly environment?: string;
  readonly deploymentState?: string;
  readonly ref?: string;
  readonly productionEnvironment?: string;
  readonly creator?: string;
  readonly app?: string;
  readonly commentPrefix?: string;
}

const SCHEDULE_KINDS = ["cron", "once", "loop"] as const;
const EVENT_KINDS = [
  "gmail-new-message",
  "gmail-label-applied",
  "github-label-applied",
  "github-workflow-run-completed",
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
  "notion-child-page-created",
  "notion-database-item-created",
  "notion-page-content-updated",
  "webhook",
] as const;
const GITHUB_WEBHOOK_EVENT_KINDS = [
  "github-workflow-job-completed",
  "github-pull-request-review-submitted",
  "github-deployment-status-created",
  "github-issue-comment-created",
] as const;
const STRAPI_EVENT_KINDS = ["strapi-entry-published"] as const;
const CHAT_EVENT_KINDS = ["chat-run-finished"] as const;
const CHAT_RUN_FINISHED_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

function githubWebhookAutomationsEnabled(): boolean {
  const payload = decodeZeroTokenPayload();
  return isFeatureEnabled(FeatureSwitchKey.GithubWebhookAutomations, {
    userId: payload?.userId,
    orgId: payload?.orgId,
  });
}

function zeroChatMessagingEnabled(): boolean {
  const payload = decodeZeroTokenPayload();
  return isFeatureEnabled(FeatureSwitchKey.ZeroChatMessaging, {
    userId: payload?.userId,
    orgId: payload?.orgId,
  });
}

function strapiIntegrationEnabled(): boolean {
  const payload = decodeZeroTokenPayload();
  return isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, {
    userId: payload?.userId,
    orgId: payload?.orgId,
  });
}

function automationKinds(): readonly string[] {
  return [
    ...SCHEDULE_KINDS,
    ...EVENT_KINDS,
    ...(githubWebhookAutomationsEnabled() ? GITHUB_WEBHOOK_EVENT_KINDS : []),
    ...(strapiIntegrationEnabled() ? STRAPI_EVENT_KINDS : []),
    ...(zeroChatMessagingEnabled() ? CHAT_EVENT_KINDS : []),
  ];
}

async function loadWorkflowAutomationThreadModel(
  automation: ZeroWorkflowAutomationSummary,
): Promise<WorkflowAutomationThreadModel | undefined> {
  if (!automation.chatThreadId) {
    return undefined;
  }

  const thread = await getZeroChatThread({
    threadId: automation.chatThreadId,
  });
  const modelId =
    thread.selectedModel ??
    (await listZeroModelPolicies()).workspaceDefaultModel;
  if (!modelId) {
    throw new Error(
      `Chat thread "${automation.chatThreadId}" has no available model`,
    );
  }

  return {
    id: modelId,
    label: getModelDisplayName(modelId),
  };
}

async function tryLoadWorkflowAutomationThreadModel(
  automation: ZeroWorkflowAutomationSummary,
): Promise<WorkflowAutomationThreadModel | undefined> {
  try {
    return await loadWorkflowAutomationThreadModel(automation);
  } catch (error) {
    console.warn(
      chalk.yellow(
        `⚠ Automation changed, but thread model details could not be loaded: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      ),
    );
    return undefined;
  }
}

function githubWebhookEventKind(
  kind: string,
): kind is (typeof GITHUB_WEBHOOK_EVENT_KINDS)[number] {
  return GITHUB_WEBHOOK_EVENT_KINDS.some((eventKind) => {
    return eventKind === kind;
  });
}
const EXACTLY_ONE_FLAG_MESSAGE =
  "Provide exactly one of --expr (cron), --at (once), --every (loop), Gmail match options, --label, --subject, --actor, --calendar-id, --page-url, --parent-page-url, or --database-url";

function addGmailAutomationOptions(command: Command): Command {
  return command
    .option(
      "--config <path>",
      "Path to a Gmail new message automation config JSON",
    )
    .option("--label <name>", "Label name for label-applied automations")
    .option("--from-contains <text>", "Require the From header to contain text")
    .option(
      "--from-not-contains <text>",
      "Require the From header not to contain text",
    )
    .option(
      "--subject-contains <text>",
      "Require the Subject header to contain text",
    )
    .option(
      "--subject-not-contains <text>",
      "Require the Subject header not to contain text",
    )
    .option(
      "--body-contains <text>",
      "Require the message body to contain text",
    )
    .option(
      "--body-not-contains <text>",
      "Require the message body not to contain text",
    )
    .option("--to-contains <text>", "Require the To header to contain text")
    .option(
      "--to-not-contains <text>",
      "Require the To header not to contain text",
    )
    .option("--cc-contains <text>", "Require the Cc header to contain text")
    .option(
      "--cc-not-contains <text>",
      "Require the Cc header not to contain text",
    );
}

function addGithubAutomationOptions(command: Command): Command {
  return command
    .option(
      "--subject <subject>",
      "GitHub subject filter for label/comment automations: both | issues | pull-requests",
    )
    .option(
      "--actor <actor>",
      "GitHub actor filter: me | anyone for labels, or comma-separated logins for workflow runs",
    )
    .option(
      "--repository <repositories>",
      "GitHub repositories, comma-separated owner/name values",
    )
    .option(
      "--workflow <workflows>",
      "GitHub workflows, comma-separated IDs, names, or paths",
    )
    .option(
      "--conclusion <conclusions>",
      "Workflow run or job conclusions, comma-separated values",
    )
    .option(
      "--branch <branches>",
      "Workflow run or job branches, comma-separated",
    )
    .option(
      "--triggering-event <events>",
      "Workflow run triggering events, comma-separated",
    )
    .option("--job <jobs>", "GitHub Actions job names or IDs, comma-separated")
    .option("--runner-label <labels>", "Runner labels, comma-separated")
    .option(
      "--runner-group <groups>",
      "Runner group names or IDs, comma-separated",
    )
    .option(
      "--review-state <states>",
      "Review states: approved, changes_requested, commented, or any",
    )
    .option(
      "--base-branch <branches>",
      "Pull request base branches, comma-separated",
    )
    .option(
      "--head-branch <branches>",
      "Pull request head branches, comma-separated",
    )
    .option(
      "--trusted-author <logins>",
      "Trusted GitHub author logins, comma-separated; omit to allow anyone",
    )
    .option("--environment <names>", "Deployment environments, comma-separated")
    .option("--deployment-state <states>", "Deployment states, comma-separated")
    .option("--ref <refs>", "Deployment refs, comma-separated")
    .option(
      "--production-environment <value>",
      "Deployment environment filter: true | false | any",
    )
    .option(
      "--creator <logins>",
      "Deployment creator logins or IDs, comma-separated",
    )
    .option(
      "--app <apps>",
      "Deployment GitHub App slugs, names, or IDs, comma-separated",
    )
    .option(
      "--comment-prefix <prefixes>",
      "Required trimmed comment prefixes, comma-separated",
    );
}

function timezoneOrUtc(timezone: string | undefined): string {
  return timezone ?? "UTC";
}

function assertValidTimezone(timezone: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function parseLocalDateTime(value: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
} {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (!match) {
    throw new Error(
      `Invalid at time: "${value}". Use ISO datetime, e.g. 2026-06-10T09:00 or 2026-06-10T09:00:00Z`,
    );
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
    millisecond: match[7] ? Number(match[7].padEnd(3, "0")) : 0,
  };
}

function zonedParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") {
      values.set(part.type, part.value);
    }
  }
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function wallTimeToUtcIso(value: string, timezone: string): string {
  assertValidTimezone(timezone);
  if (hasExplicitOffset(value)) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) {
      throw new Error(`Invalid at time: "${value}"`);
    }
    return instant.toISOString();
  }

  const target = parseLocalDateTime(value);
  const targetUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
    target.millisecond,
  );
  let guess = targetUtc;
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(new Date(guess), timezone);
    const renderedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      target.millisecond,
    );
    guess += targetUtc - renderedUtc;
  }

  const result = new Date(guess);
  const rendered = zonedParts(result, timezone);
  if (
    rendered.year !== target.year ||
    rendered.month !== target.month ||
    rendered.day !== target.day ||
    rendered.hour !== target.hour ||
    rendered.minute !== target.minute ||
    rendered.second !== target.second
  ) {
    throw new Error(
      `Invalid at time for ${timezone}: "${value}". The local time does not exist`,
    );
  }
  return result.toISOString();
}

function buildSchedule(
  kind: string,
  options: UpdateOptions,
): ZeroWorkflowSchedule {
  switch (kind) {
    case "cron":
      if (!options.expr) {
        throw new Error(
          'cron automations require --expr (e.g. --expr "0 9 * * *")',
        );
      }
      return {
        type: "cron",
        cronExpression: options.expr,
        timezone: timezoneOrUtc(options.timezone),
      };
    case "once": {
      if (!options.at) {
        throw new Error(
          'once automations require --at (e.g. --at "2026-06-10T09:00")',
        );
      }
      const timezone = timezoneOrUtc(options.timezone);
      return {
        type: "once",
        atTime: wallTimeToUtcIso(options.at, timezone),
        timezone,
      };
    }
    case "loop":
      if (!options.every) {
        throw new Error("loop automations require --every (e.g. --every 15m)");
      }
      return {
        type: "loop",
        intervalSeconds: parseDurationSeconds(options.every),
      };
    default:
      throw new Error(
        `Unknown automation kind: "${kind}". Use one of: ${automationKinds().join(", ")}`,
      );
  }
}

function hasScheduleAddOptions(options: AddOptions): boolean {
  return (
    options.expr !== undefined ||
    options.at !== undefined ||
    options.every !== undefined ||
    options.timezone !== undefined
  );
}

function hasGithubLabelAutomationOptions(
  options: AddOptions | UpdateOptions,
): boolean {
  return options.subject !== undefined || options.actor !== undefined;
}

function hasGithubWorkflowRunSpecificOptions(
  options: AddOptions | UpdateOptions,
): boolean {
  return (
    options.repository !== undefined ||
    options.workflow !== undefined ||
    options.conclusion !== undefined ||
    options.branch !== undefined ||
    options.triggeringEvent !== undefined
  );
}

type GithubAutomationOptionKey =
  | "subject"
  | "actor"
  | "repository"
  | "workflow"
  | "job"
  | "conclusion"
  | "branch"
  | "triggeringEvent"
  | "runnerLabel"
  | "runnerGroup"
  | "reviewState"
  | "baseBranch"
  | "headBranch"
  | "trustedAuthor"
  | "environment"
  | "deploymentState"
  | "ref"
  | "productionEnvironment"
  | "creator"
  | "app"
  | "commentPrefix";

const GITHUB_AUTOMATION_OPTION_KEYS: readonly GithubAutomationOptionKey[] = [
  "subject",
  "actor",
  "repository",
  "workflow",
  "job",
  "conclusion",
  "branch",
  "triggeringEvent",
  "runnerLabel",
  "runnerGroup",
  "reviewState",
  "baseBranch",
  "headBranch",
  "trustedAuthor",
  "environment",
  "deploymentState",
  "ref",
  "productionEnvironment",
  "creator",
  "app",
  "commentPrefix",
];

function githubOptionValue(
  options: AddOptions | UpdateOptions,
  key: GithubAutomationOptionKey,
): string | undefined {
  return options[key];
}

function hasGithubWebhookOptions(options: AddOptions | UpdateOptions): boolean {
  return GITHUB_AUTOMATION_OPTION_KEYS.some((key) => {
    return githubOptionValue(options, key) !== undefined;
  });
}

function hasGithubAutomationOptions(
  options: AddOptions | UpdateOptions,
): boolean {
  return (
    hasGithubLabelAutomationOptions(options) ||
    hasGithubWorkflowRunSpecificOptions(options) ||
    hasGithubWebhookOptions(options)
  );
}

function assertOnlyGithubAutomationOptions(
  options: AddOptions | UpdateOptions,
  allowed: readonly GithubAutomationOptionKey[],
): void {
  const invalid = GITHUB_AUTOMATION_OPTION_KEYS.find((key) => {
    return (
      githubOptionValue(options, key) !== undefined && !allowed.includes(key)
    );
  });
  if (invalid) {
    throw new Error(
      `--${invalid.replace(/[A-Z]/g, (match) => {
        return `-${match.toLowerCase()}`;
      })} does not apply to this GitHub automation`,
    );
  }
}

function hasAnyGithubAutomationOption(
  options: AddOptions | UpdateOptions,
  allowed: readonly GithubAutomationOptionKey[],
): boolean {
  return allowed.some((key) => {
    return githubOptionValue(options, key) !== undefined;
  });
}

function hasCalendarAutomationOptions(options: AddOptions): boolean {
  return options.calendarId !== undefined;
}

function hasNotionAutomationOptions(options: AddOptions): boolean {
  return (
    options.pageUrl !== undefined ||
    options.parentPageUrl !== undefined ||
    options.databaseUrl !== undefined
  );
}

function hasStrapiAutomationOptions(options: AddOptions): boolean {
  return (
    options.integrationId !== undefined ||
    options.contentTypeUid !== undefined ||
    options.locale !== undefined
  );
}

function hasChatRunFinishedAutomationOptions(options: AddOptions): boolean {
  return (
    options.chatThreadId !== undefined ||
    options.runStatus !== undefined ||
    options.outputPattern !== undefined
  );
}

function hasEventAddOptions(options: AddOptions): boolean {
  return (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasNotionAutomationOptions(options) ||
    hasStrapiAutomationOptions(options) ||
    hasChatRunFinishedAutomationOptions(options)
  );
}

function assertNoScheduleAddOptions(options: AddOptions): void {
  if (hasScheduleAddOptions(options)) {
    throw new Error(
      "--expr, --at, --every, and --timezone only apply to schedule automations",
    );
  }
}

function assertNoGithubAutomationOptions(
  options: AddOptions,
  message = "GitHub automation flags only apply to GitHub event automations",
): void {
  if (hasGithubAutomationOptions(options)) {
    throw new Error(message);
  }
}

function assertNoCalendarAutomationOptions(options: AddOptions): void {
  if (hasCalendarAutomationOptions(options)) {
    throw new Error(
      "Google Calendar automation flags only apply to Google Calendar event automations",
    );
  }
}

function assertNoNotionAutomationOptions(options: AddOptions): void {
  if (hasNotionAutomationOptions(options)) {
    throw new Error(
      "Notion automation flags only apply to Notion event automations",
    );
  }
}

function assertNoStrapiAutomationOptions(options: AddOptions): void {
  if (hasStrapiAutomationOptions(options)) {
    throw new Error(
      "Strapi automation flags only apply to Strapi event automations",
    );
  }
}

function scheduleUpdateFlagCount(options: UpdateOptions): number {
  return [options.expr, options.at, options.every].filter((value) => {
    return value !== undefined;
  }).length;
}

function hasScheduleUpdateOptions(options: UpdateOptions): boolean {
  return scheduleUpdateFlagCount(options) > 0 || options.timezone !== undefined;
}

function parseGithubSubject(
  value: string | undefined,
  fallback: GithubLabelAppliedSubjectFilter = "both",
): GithubLabelAppliedSubjectFilter {
  if (value === undefined) {
    return fallback;
  }
  switch (value) {
    case "both":
    case "issues":
      return value;
    case "pull-requests":
      return "pull_requests";
    default:
      throw new Error(
        `Invalid --subject "${value}". Use one of: both, issues, pull-requests`,
      );
  }
}

function parseGithubActor(
  value: string | undefined,
  fallback: "me" | "anyone" = "me",
): "me" | "anyone" {
  if (value === undefined) {
    return fallback;
  }
  if (value === "me" || value === "anyone") {
    return value;
  }
  throw new Error(`Invalid --actor "${value}". Use one of: me, anyone`);
}

function buildGithubLabelAppliedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    ZeroWorkflowAutomationSummary,
    { readonly kind: "event"; readonly eventType: "github-label-applied" }
  >,
) {
  const labelName = options.label?.trim() ?? existing?.eventConfig.labelName;
  if (!labelName) {
    throw new Error(
      'github-label-applied automations require --label "Label name"',
    );
  }

  return {
    provider: "github" as const,
    event: "label_applied" as const,
    labelName,
    filters: {
      subject: parseGithubSubject(
        options.subject,
        existing?.eventConfig.filters.subject ?? "both",
      ),
      actor: {
        type: parseGithubActor(
          options.actor,
          existing?.eventConfig.filters.actor.type ?? "me",
        ),
      },
    },
  };
}

const GITHUB_WORKFLOW_RUN_CONCLUSIONS: readonly GithubWorkflowRunConclusion[] =
  [
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "startup_failure",
    "success",
    "timed_out",
  ];

function parseGithubWorkflowRunFilter(
  value: string | undefined,
  fallback: readonly string[] | undefined,
): string[] | undefined {
  if (value === undefined) {
    return fallback ? [...fallback] : undefined;
  }
  if (value.trim().toLowerCase() === "any") {
    return undefined;
  }
  const values = Array.from(
    new Set(
      value
        .split(",")
        .map((part) => {
          return part.trim();
        })
        .filter(Boolean),
    ),
  );
  if (values.length === 0) {
    throw new Error("GitHub filters cannot be empty; use any");
  }
  return values;
}

function parseGithubWorkflowRunConclusions(
  value: string | undefined,
  fallback: readonly GithubWorkflowRunConclusion[] | undefined,
): GithubWorkflowRunConclusion[] | undefined {
  const values = parseGithubWorkflowRunFilter(value, fallback);
  if (!values) {
    return undefined;
  }
  return values.map((conclusion) => {
    if (
      GITHUB_WORKFLOW_RUN_CONCLUSIONS.includes(
        conclusion as GithubWorkflowRunConclusion,
      )
    ) {
      return conclusion as GithubWorkflowRunConclusion;
    }
    throw new Error(
      `Invalid --conclusion "${conclusion}". Use one of: ${GITHUB_WORKFLOW_RUN_CONCLUSIONS.join(", ")}, any`,
    );
  });
}

const GITHUB_PULL_REQUEST_REVIEW_STATES: readonly GithubPullRequestReviewState[] =
  ["approved", "changes_requested", "commented"];

const GITHUB_DEPLOYMENT_STATES: readonly GithubDeploymentState[] = [
  "error",
  "failure",
  "inactive",
  "in_progress",
  "pending",
  "queued",
  "success",
  "waiting",
];

function parseGithubReviewStates(
  value: string | undefined,
  fallback: readonly GithubPullRequestReviewState[] | undefined,
): GithubPullRequestReviewState[] | undefined {
  const values = parseGithubWorkflowRunFilter(value, fallback);
  if (!values) {
    return undefined;
  }
  return values.map((state) => {
    if (
      GITHUB_PULL_REQUEST_REVIEW_STATES.includes(
        state as GithubPullRequestReviewState,
      )
    ) {
      return state as GithubPullRequestReviewState;
    }
    throw new Error(
      `Invalid --review-state "${state}". Use one of: ${GITHUB_PULL_REQUEST_REVIEW_STATES.join(", ")}, any`,
    );
  });
}

function parseGithubDeploymentStates(
  value: string | undefined,
  fallback: readonly GithubDeploymentState[] | undefined,
): GithubDeploymentState[] | undefined {
  const values = parseGithubWorkflowRunFilter(value, fallback);
  if (!values) {
    return undefined;
  }
  return values.map((state) => {
    if (GITHUB_DEPLOYMENT_STATES.includes(state as GithubDeploymentState)) {
      return state as GithubDeploymentState;
    }
    throw new Error(
      `Invalid --deployment-state "${state}". Use one of: ${GITHUB_DEPLOYMENT_STATES.join(", ")}, any`,
    );
  });
}

function parseProductionEnvironment(
  value: string | undefined,
  fallback: boolean | undefined,
): boolean | undefined {
  if (value === undefined) {
    return fallback;
  }
  switch (value.trim().toLowerCase()) {
    case "any":
      return undefined;
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw new Error(
        `Invalid --production-environment "${value}". Use true, false, or any`,
      );
  }
}

function buildGithubWorkflowRunCompletedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    ZeroWorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-workflow-run-completed";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "workflow_run_completed" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      workflows: parseGithubWorkflowRunFilter(
        options.workflow,
        filters?.workflows,
      ),
      conclusions: parseGithubWorkflowRunConclusions(
        options.conclusion,
        filters?.conclusions,
      ),
      branches: parseGithubWorkflowRunFilter(options.branch, filters?.branches),
      events: parseGithubWorkflowRunFilter(
        options.triggeringEvent,
        filters?.events,
      ),
      actors: parseGithubWorkflowRunFilter(options.actor, filters?.actors),
    },
  };
}

function buildGithubWorkflowJobCompletedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    ZeroWorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-workflow-job-completed";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "workflow_job_completed" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      workflows: parseGithubWorkflowRunFilter(
        options.workflow,
        filters?.workflows,
      ),
      jobs: parseGithubWorkflowRunFilter(options.job, filters?.jobs),
      conclusions: parseGithubWorkflowRunConclusions(
        options.conclusion,
        filters?.conclusions,
      ),
      branches: parseGithubWorkflowRunFilter(options.branch, filters?.branches),
      runnerLabels: parseGithubWorkflowRunFilter(
        options.runnerLabel,
        filters?.runnerLabels,
      ),
      runnerGroups: parseGithubWorkflowRunFilter(
        options.runnerGroup,
        filters?.runnerGroups,
      ),
    },
  };
}

function buildGithubPullRequestReviewSubmittedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    ZeroWorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-pull-request-review-submitted";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "pull_request_review_submitted" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      reviewStates: parseGithubReviewStates(
        options.reviewState,
        filters?.reviewStates,
      ),
      baseBranches: parseGithubWorkflowRunFilter(
        options.baseBranch,
        filters?.baseBranches,
      ),
      headBranches: parseGithubWorkflowRunFilter(
        options.headBranch,
        filters?.headBranches,
      ),
      trustedAuthors: parseGithubWorkflowRunFilter(
        options.trustedAuthor,
        filters?.trustedAuthors,
      ),
    },
  };
}

function buildGithubDeploymentStatusCreatedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    ZeroWorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-deployment-status-created";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "deployment_status_created" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      environments: parseGithubWorkflowRunFilter(
        options.environment,
        filters?.environments,
      ),
      states: parseGithubDeploymentStates(
        options.deploymentState,
        filters?.states,
      ),
      refs: parseGithubWorkflowRunFilter(options.ref, filters?.refs),
      productionEnvironment: parseProductionEnvironment(
        options.productionEnvironment,
        filters?.productionEnvironment,
      ),
      creators: parseGithubWorkflowRunFilter(
        options.creator,
        filters?.creators,
      ),
      apps: parseGithubWorkflowRunFilter(options.app, filters?.apps),
    },
  };
}

function buildGithubIssueCommentCreatedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    ZeroWorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-issue-comment-created";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "issue_comment_created" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      subject: parseGithubSubject(options.subject, filters?.subject ?? "both"),
      trustedAuthors: parseGithubWorkflowRunFilter(
        options.trustedAuthor,
        filters?.trustedAuthors,
      ),
      commentPrefixes: parseGithubWorkflowRunFilter(
        options.commentPrefix,
        filters?.commentPrefixes,
      ),
    },
  };
}

function buildGmailNewMessageCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailLabelOption(options)) {
    throw new Error("--label only applies to label-applied event automations");
  }
  assertNoGithubAutomationOptions(options);
  assertNoCalendarAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  assertNoStrapiAutomationOptions(options);
  return {
    kind: "event",
    eventType: "gmail-new-message",
    eventConfig: buildGmailNewMessageEventConfig(options),
  };
}

function buildGmailLabelAppliedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options)) {
    throw new Error(
      "Gmail match flags and --config only apply to gmail-new-message automations",
    );
  }
  assertNoGithubAutomationOptions(options);
  assertNoCalendarAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  assertNoStrapiAutomationOptions(options);
  return {
    kind: "event",
    eventType: "gmail-label-applied",
    eventConfig: buildGmailLabelAppliedEventConfig(options),
  };
}

function buildGithubLabelAppliedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options)) {
    throw new Error(
      "Gmail match flags and --config only apply to Gmail event automations",
    );
  }
  assertNoCalendarAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  assertNoStrapiAutomationOptions(options);
  if (hasGithubWorkflowRunSpecificOptions(options)) {
    throw new Error(
      "Workflow run filter flags only apply to github-workflow-run-completed automations",
    );
  }
  assertOnlyGithubAutomationOptions(options, ["subject", "actor"]);
  return {
    kind: "event",
    eventType: "github-label-applied",
    eventConfig: buildGithubLabelAppliedEventConfig(options),
  };
}

function buildGithubWorkflowRunCompletedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options) || hasGmailLabelOption(options)) {
    throw new Error(
      "Gmail automation flags only apply to Gmail event automations",
    );
  }
  if (options.subject !== undefined) {
    throw new Error(
      "--subject only applies to github-label-applied automations",
    );
  }
  assertOnlyGithubAutomationOptions(options, [
    "repository",
    "workflow",
    "conclusion",
    "branch",
    "triggeringEvent",
    "actor",
  ]);
  assertNoCalendarAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  assertNoStrapiAutomationOptions(options);
  return {
    kind: "event",
    eventType: "github-workflow-run-completed",
    eventConfig: buildGithubWorkflowRunCompletedEventConfig(options),
  };
}

function assertGithubWebhookCreateOptions(
  options: AddOptions,
  allowed: readonly GithubAutomationOptionKey[],
): void {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options) || hasGmailLabelOption(options)) {
    throw new Error(
      "Gmail automation flags only apply to Gmail event automations",
    );
  }
  assertNoCalendarAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  assertNoStrapiAutomationOptions(options);
  assertOnlyGithubAutomationOptions(options, allowed);
}

function buildGithubWorkflowJobCompletedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "workflow",
    "job",
    "conclusion",
    "branch",
    "runnerLabel",
    "runnerGroup",
  ]);
  return {
    kind: "event",
    eventType: "github-workflow-job-completed",
    eventConfig: buildGithubWorkflowJobCompletedEventConfig(options),
  };
}

function buildGithubPullRequestReviewSubmittedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "reviewState",
    "baseBranch",
    "headBranch",
    "trustedAuthor",
  ]);
  return {
    kind: "event",
    eventType: "github-pull-request-review-submitted",
    eventConfig: buildGithubPullRequestReviewSubmittedEventConfig(options),
  };
}

function buildGithubDeploymentStatusCreatedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "environment",
    "deploymentState",
    "ref",
    "productionEnvironment",
    "creator",
    "app",
  ]);
  return {
    kind: "event",
    eventType: "github-deployment-status-created",
    eventConfig: buildGithubDeploymentStatusCreatedEventConfig(options),
  };
}

function buildGithubIssueCommentCreatedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "subject",
    "trustedAuthor",
    "commentPrefix",
  ]);
  return {
    kind: "event",
    eventType: "github-issue-comment-created",
    eventConfig: buildGithubIssueCommentCreatedEventConfig(options),
  };
}

function buildGoogleCalendarEventCreateRequest(
  eventType:
    | "google-calendar-event-created"
    | "google-calendar-event-updated"
    | "google-calendar-event-cancelled",
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasNotionAutomationOptions(options) ||
    hasStrapiAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Notion, and Strapi automation flags only apply to their event automations",
    );
  }
  const calendarId = options.calendarId?.trim() || "primary";
  if (eventType === "google-calendar-event-created") {
    return {
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId,
      },
    };
  }
  if (eventType === "google-calendar-event-updated") {
    return {
      kind: "event",
      eventType: "google-calendar-event-updated",
      eventConfig: {
        provider: "google-calendar",
        event: "event_updated",
        calendarId,
      },
    };
  }
  return {
    kind: "event",
    eventType: "google-calendar-event-cancelled",
    eventConfig: {
      provider: "google-calendar",
      event: "event_cancelled",
      calendarId,
    },
  };
}

function buildNotionChildPageCreatedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasStrapiAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Google Calendar, and Strapi automation flags only apply to their event automations",
    );
  }

  const parentPageUrl = options.parentPageUrl?.trim();
  if (options.pageUrl !== undefined || options.databaseUrl !== undefined) {
    throw new Error(
      "--page-url and --database-url do not apply to notion-child-page-created automations",
    );
  }
  if (!parentPageUrl) {
    throw new Error(
      'notion-child-page-created automations require --parent-page-url "https://www.notion.so/..."',
    );
  }

  return {
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      parentPageUrl,
    },
  };
}

function buildNotionDatabaseItemCreatedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasStrapiAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Google Calendar, and Strapi automation flags only apply to their event automations",
    );
  }

  if (options.pageUrl !== undefined || options.parentPageUrl !== undefined) {
    throw new Error(
      "--page-url and --parent-page-url do not apply to notion-database-item-created automations",
    );
  }
  const databaseUrl = options.databaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error(
      'notion-database-item-created automations require --database-url "https://www.notion.so/..."',
    );
  }

  return {
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      databaseUrl,
    },
  };
}

function buildNotionPageContentUpdatedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasStrapiAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Google Calendar, and Strapi automation flags only apply to their event automations",
    );
  }

  if (options.parentPageUrl !== undefined) {
    throw new Error(
      "--parent-page-url only applies to notion-child-page-created automations",
    );
  }
  const pageUrl = options.pageUrl?.trim();
  const databaseUrl = options.databaseUrl?.trim();
  const invalidScopeMessage =
    'notion-page-content-updated automations require exactly one of --page-url "https://www.notion.so/..." or --database-url "https://www.notion.so/..."';
  if (pageUrl && databaseUrl) {
    throw new Error(invalidScopeMessage);
  }

  if (pageUrl) {
    return {
      kind: "event",
      eventType: "notion-page-content-updated",
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        pageUrl,
      },
    };
  }
  if (!databaseUrl) {
    throw new Error(invalidScopeMessage);
  }
  return {
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      databaseUrl,
    },
  };
}

function parseChatRunFinishedStatuses(
  value: string,
): ChatRunFinishedRunStatus[] {
  const statuses = value
    .split(",")
    .map((status) => {
      return status.trim();
    })
    .filter((status) => {
      return status.length > 0;
    });
  if (statuses.length === 0) {
    throw new Error(
      `--run-status requires at least one of: ${CHAT_RUN_FINISHED_STATUSES.join(", ")}`,
    );
  }
  return statuses.map((status) => {
    const match = CHAT_RUN_FINISHED_STATUSES.find((candidate) => {
      return candidate === status;
    });
    if (!match) {
      throw new Error(
        `Invalid --run-status value "${status}"; expected one of: ${CHAT_RUN_FINISHED_STATUSES.join(", ")}`,
      );
    }
    return match;
  });
}

function buildChatRunFinishedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasNotionAutomationOptions(options) ||
    hasStrapiAutomationOptions(options)
  ) {
    throw new Error(
      "Only --chat-thread-id, --run-status, and --output-pattern apply to chat-run-finished automations",
    );
  }
  const chatThreadId = options.chatThreadId?.trim();
  if (!chatThreadId) {
    throw new Error(
      "chat-run-finished automations require --chat-thread-id <uuid>",
    );
  }
  const runStatuses =
    options.runStatus === undefined
      ? undefined
      : parseChatRunFinishedStatuses(options.runStatus);
  const outputPattern = options.outputPattern?.trim();
  return {
    kind: "event",
    eventType: "chat-run-finished",
    eventConfig: {
      provider: "chat",
      event: "run_finished",
      chatThreadId,
      ...(runStatuses ? { runStatuses } : {}),
      ...(outputPattern ? { outputPattern } : {}),
    },
  };
}

function buildWebhookCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasEventAddOptions(options)) {
    throw new Error("Event automation flags only apply to event automations");
  }
  return {
    kind: "event",
    eventType: "webhook-received",
    eventConfig: {
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    },
  };
}

function buildStrapiEntryPublishedCreateRequest(
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasNotionAutomationOptions(options)
  ) {
    throw new Error(
      "Only Strapi automation flags apply to strapi-entry-published automations",
    );
  }
  const integrationId = options.integrationId?.trim();
  if (!integrationId) {
    throw new Error(
      "strapi-entry-published automations require --integration-id <uuid>",
    );
  }
  const contentTypeUid = options.contentTypeUid?.trim();
  const locale = options.locale?.trim();
  return {
    kind: "event",
    eventType: "strapi-entry-published",
    eventConfig: {
      provider: "strapi",
      event: "entry_published",
      integrationId,
      ...(contentTypeUid ? { contentTypeUid } : {}),
      ...(locale ? { locale } : {}),
    },
  };
}

function buildScheduleCreateRequest(
  kind: string,
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  if (hasEventAddOptions(options)) {
    throw new Error("Event automation flags only apply to event automations");
  }
  return { schedule: buildSchedule(kind, options) };
}

function buildCreateRequest(
  kind: string,
  options: AddOptions,
): ZeroWorkflowAutomationCreateRequest {
  switch (kind) {
    case "gmail-new-message":
      return buildGmailNewMessageCreateRequest(options);
    case "gmail-label-applied":
      return buildGmailLabelAppliedCreateRequest(options);
    case "github-label-applied":
      return buildGithubLabelAppliedCreateRequest(options);
    case "github-workflow-run-completed":
      return buildGithubWorkflowRunCompletedCreateRequest(options);
    case "github-workflow-job-completed":
      return buildGithubWorkflowJobCompletedCreateRequest(options);
    case "github-pull-request-review-submitted":
      return buildGithubPullRequestReviewSubmittedCreateRequest(options);
    case "github-deployment-status-created":
      return buildGithubDeploymentStatusCreatedCreateRequest(options);
    case "github-issue-comment-created":
      return buildGithubIssueCommentCreatedCreateRequest(options);
    case "google-calendar-event-created":
      return buildGoogleCalendarEventCreateRequest(kind, options);
    case "google-calendar-event-updated":
      return buildGoogleCalendarEventCreateRequest(kind, options);
    case "google-calendar-event-cancelled":
      return buildGoogleCalendarEventCreateRequest(kind, options);
    case "notion-child-page-created":
      return buildNotionChildPageCreatedCreateRequest(options);
    case "notion-database-item-created":
      return buildNotionDatabaseItemCreatedCreateRequest(options);
    case "notion-page-content-updated":
      return buildNotionPageContentUpdatedCreateRequest(options);
    case "strapi-entry-published":
      return buildStrapiEntryPublishedCreateRequest(options);
    case "chat-run-finished":
      return buildChatRunFinishedCreateRequest(options);
    case "webhook":
      return buildWebhookCreateRequest(options);
    default:
      return buildScheduleCreateRequest(kind, options);
  }
}

function buildGithubWorkflowEventUpdate(
  options: UpdateOptions,
  existing: Extract<ZeroWorkflowAutomationSummary, { readonly kind: "event" }>,
): ZeroWorkflowAutomationUpdateRequest | undefined {
  switch (existing.eventType) {
    case "github-workflow-run-completed": {
      if (
        hasGmailAutomationOptions(options) ||
        hasGmailLabelOption(options) ||
        options.subject !== undefined
      ) {
        throw new Error(
          "Gmail, label, and subject flags do not apply to GitHub workflow run automations",
        );
      }
      if (!hasGithubAutomationOptions(options)) {
        throw new Error(
          "Provide a GitHub workflow run filter flag; use any to clear a filter",
        );
      }
      assertOnlyGithubAutomationOptions(options, [
        "repository",
        "workflow",
        "conclusion",
        "branch",
        "triggeringEvent",
        "actor",
      ]);
      return {
        eventConfig: buildGithubWorkflowRunCompletedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-workflow-job-completed": {
      const allowed = [
        "repository",
        "workflow",
        "job",
        "conclusion",
        "branch",
        "runnerLabel",
        "runnerGroup",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub workflow job filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubWorkflowJobCompletedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-pull-request-review-submitted": {
      const allowed = [
        "repository",
        "reviewState",
        "baseBranch",
        "headBranch",
        "trustedAuthor",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub pull request review filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubPullRequestReviewSubmittedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-deployment-status-created": {
      const allowed = [
        "repository",
        "environment",
        "deploymentState",
        "ref",
        "productionEnvironment",
        "creator",
        "app",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub deployment status filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubDeploymentStatusCreatedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-issue-comment-created": {
      const allowed = [
        "repository",
        "subject",
        "trustedAuthor",
        "commentPrefix",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub issue comment filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubIssueCommentCreatedEventConfig(
          options,
          existing,
        ),
      };
    }
    default:
      return undefined;
  }
}

function buildEventUpdate(
  options: UpdateOptions,
  existing: Extract<ZeroWorkflowAutomationSummary, { readonly kind: "event" }>,
): ZeroWorkflowAutomationUpdateRequest {
  const hasGmailOptions = hasGmailAutomationOptions(options);
  const hasLabelOption = hasGmailLabelOption(options);
  const hasGithubOptions = hasGithubAutomationOptions(options);

  if (
    existing.eventType === "google-calendar-event-created" ||
    existing.eventType === "google-calendar-event-updated" ||
    existing.eventType === "google-calendar-event-cancelled"
  ) {
    throw new Error("Google Calendar event automations cannot be updated");
  }

  if (existing.eventType === "github-label-applied") {
    if (hasGmailOptions) {
      throw new Error(
        "Gmail match flags only apply to Gmail event automations",
      );
    }
    if (hasGithubWorkflowRunSpecificOptions(options)) {
      throw new Error(
        "Workflow run filter flags only apply to github-workflow-run-completed automations",
      );
    }
    assertOnlyGithubAutomationOptions(options, ["subject", "actor"]);
    if (!hasLabelOption && !hasGithubOptions) {
      throw new Error(
        "Provide --label, --subject, or --actor for github-label-applied automations",
      );
    }
    return {
      eventConfig: buildGithubLabelAppliedEventConfig(options, existing),
    };
  }

  const githubWorkflowUpdate = buildGithubWorkflowEventUpdate(
    options,
    existing,
  );
  if (githubWorkflowUpdate) {
    return githubWorkflowUpdate;
  }

  if (hasGithubOptions) {
    throw new Error(
      "GitHub automation flags only apply to GitHub event automations",
    );
  }

  if (existing.eventType === "gmail-label-applied") {
    if (!hasLabelOption || hasGmailOptions) {
      throw new Error("Use --label for gmail-label-applied automations");
    }
    return { eventConfig: buildGmailLabelAppliedEventConfig(options) };
  }

  if (existing.eventType !== "gmail-new-message") {
    throw new Error("This event automation cannot be updated");
  }
  if (!hasGmailOptions || hasLabelOption) {
    throw new Error(
      "Use Gmail match options for gmail-new-message automations",
    );
  }
  return {
    eventConfig: buildGmailNewMessageEventConfig(options, existing.eventConfig),
  };
}

function buildScheduleUpdate(
  options: UpdateOptions,
): ZeroWorkflowAutomationUpdateRequest {
  const hasGmailOptions = hasGmailAutomationOptions(options);
  const hasLabelOption = hasGmailLabelOption(options);
  if (hasGmailOptions || hasLabelOption) {
    throw new Error(
      "Gmail automation flags only apply to Gmail event automations",
    );
  }
  const flagCount = scheduleUpdateFlagCount(options);
  if (flagCount !== 1) {
    throw new Error(EXACTLY_ONE_FLAG_MESSAGE);
  }
  if (options.timezone && !options.expr && !options.at) {
    throw new Error("--timezone only applies to --expr and --at");
  }
  if (options.expr) {
    return { schedule: buildSchedule("cron", options) };
  }
  if (options.at) {
    return { schedule: buildSchedule("once", options) };
  }
  return { schedule: buildSchedule("loop", options) };
}

function buildUpdate(
  options: UpdateOptions,
  existing: ZeroWorkflowAutomationSummary,
): ZeroWorkflowAutomationUpdateRequest {
  const hasEventOptions =
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options);
  if (hasScheduleUpdateOptions(options) && hasEventOptions) {
    throw new Error("Use either schedule flags or event automation options");
  }
  if (hasGmailAutomationOptions(options) && hasGmailLabelOption(options)) {
    throw new Error("Use either Gmail match options or --label");
  }

  if (existing.kind === "event") {
    if (hasScheduleUpdateOptions(options)) {
      throw new Error("Schedule flags only apply to schedule automations");
    }
    return buildEventUpdate(options, existing);
  }

  if (hasGithubAutomationOptions(options)) {
    throw new Error(
      "GitHub automation flags only apply to GitHub event automations",
    );
  }
  return buildScheduleUpdate(options);
}

const addCommand = addGithubAutomationOptions(
  addGmailAutomationOptions(
    new Command()
      .name("add")
      .description("Add an automation to a workflow")
      .argument("<workflow>", "Workflow ID or name")
      .argument("<kind>", `Automation type: ${automationKinds().join(" | ")}`)
      .option("--expr <expression>", 'Cron expression for kind "cron"')
      .option("--at <iso-time>", 'Fire time for kind "once"')
      .option(
        "--every <duration>",
        'Interval for kind "loop" (e.g. 15m, 1h, 90s)',
      )
      .option(
        "-z, --timezone <tz>",
        "IANA timezone for cron/once (default: UTC)",
      ),
  ),
)
  .option(
    "--calendar-id <id>",
    "Google Calendar ID for Google Calendar event automations (default: primary)",
  )
  .option(
    "--page-url <url>",
    "Notion page URL for notion-page-content-updated automations",
  )
  .option(
    "--parent-page-url <url>",
    "Parent Notion page URL for notion-child-page-created automations",
  )
  .option(
    "--database-url <url>",
    "Notion database URL for notion-database-item-created or notion-page-content-updated automations",
  )
  .option(
    "--integration-id <uuid>",
    "Strapi integration ID for Strapi event automations",
  )
  .option(
    "--content-type-uid <uid>",
    "Optional Strapi content type UID, for example api::article.article",
  )
  .option("--locale <locale>", "Optional Strapi locale filter")
  .option(
    "--chat-thread-id <uuid>",
    "Watched chat thread ID for chat-run-finished automations",
  )
  .option(
    "--run-status <statuses>",
    "Comma-separated finish statuses for chat-run-finished automations: completed, failed, cancelled (default: all)",
  )
  .option(
    "--output-pattern <pattern>",
    "Optional * wildcard matched against the finished run's final assistant text",
  )
  .option("--agent <id>", "Agent ID for resolving a workflow name")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow automation add tell-a-joke --agent <agent-id> cron --expr "0 9 * * *" -z Asia/Shanghai
  zero workflow automation add tell-a-joke --agent <agent-id> once --at "2026-06-10T09:00" -z Asia/Shanghai
  zero workflow automation add tell-a-joke --agent <agent-id> loop --every 15m
  zero workflow automation add triage --agent <agent-id> gmail-new-message --from-contains "@example.com"
  zero workflow automation add triage --agent <agent-id> gmail-new-message --config ./gmail-automation.json
  zero workflow automation add triage --agent <agent-id> gmail-label-applied --label "Support"
  zero workflow automation add triage --agent <agent-id> github-label-applied --label "triage" --subject both --actor me
  zero workflow automation add ci-triage --agent <agent-id> github-workflow-run-completed --repository vm0-ai/vm0 --workflow Turbo --conclusion failure,timed_out --branch main --triggering-event push --actor dependabot[bot]
  zero workflow automation add triage --agent <agent-id> google-calendar-event-created
  zero workflow automation add triage --agent <agent-id> google-calendar-event-updated
  zero workflow automation add triage --agent <agent-id> google-calendar-event-cancelled
  zero workflow automation add research-notes --agent <agent-id> notion-child-page-created --parent-page-url "https://www.notion.so/workspace/Page-title-1234567890abcdef1234567890abcdef"
  zero workflow automation add research-notes --agent <agent-id> notion-database-item-created --database-url "https://www.notion.so/1234567890abcdef1234567890abcdef?v=abcdef1234567890abcdef1234567890"
  zero workflow automation add research-notes --agent <agent-id> notion-page-content-updated --page-url "https://www.notion.so/workspace/Page-title-1234567890abcdef1234567890abcdef"
  zero workflow automation add research-notes --agent <agent-id> notion-page-content-updated --database-url "https://www.notion.so/1234567890abcdef1234567890abcdef?v=abcdef1234567890abcdef1234567890"
  zero workflow automation add deploy-blog --agent <agent-id> strapi-entry-published --integration-id <uuid> --content-type-uid api::article.article
  zero workflow automation add triage --agent <agent-id> webhook
  zero workflow automation add follow-up --agent <agent-id> chat-run-finished --chat-thread-id <thread-uuid> --run-status completed,failed --output-pattern "*deploy failed*"

Notes:
  - Workflow names resolve under --agent, then ZERO_AGENT_ID
  - Gmail automations match all inbound messages when no text match rules are provided
  - GitHub automations require the GitHub App installation in the workspace
  - GitHub workflow run filters accept comma-separated values; omit a filter to match any value
  - Webhook automations print the signing secret only once after creation
  - Use the workflow ID when a name is ambiguous`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string, kind: string, options: AddOptions) => {
        if (
          githubWebhookEventKind(kind) &&
          !githubWebhookAutomationsEnabled()
        ) {
          throw new Error(
            "GitHub webhook automations are not enabled for this workspace",
          );
        }
        if (kind === "strapi-entry-published" && !strapiIntegrationEnabled()) {
          throw new Error(
            "Strapi workflow automations are not enabled for this workspace",
          );
        }
        if (kind === "chat-run-finished" && !zeroChatMessagingEnabled()) {
          throw new Error(
            "Chat run finished automations are not enabled for this workspace",
          );
        }
        if (
          options.timezone &&
          kind !== "cron" &&
          kind !== "once" &&
          kind !== "gmail-new-message"
        ) {
          throw new Error(
            "--timezone only applies to cron and once automations",
          );
        }
        const workflowId = await resolveWorkflowRef(workflowRef, options);
        const body = buildCreateRequest(kind, options);
        const automation = await createWorkflowAutomation(workflowId, body);

        console.log(
          chalk.green(`✓ Automation added to workflow "${workflowRef}"`),
        );
        const threadModel =
          await tryLoadWorkflowAutomationThreadModel(automation);
        printWorkflowAutomationDetails(automation, {
          workflowRef,
          workflowId,
          threadModel,
        });
      },
    ),
  );

const updateCommand = addGithubAutomationOptions(
  addGmailAutomationOptions(
    new Command()
      .name("update")
      .description(
        "Replace a workflow automation's schedule or event filter config",
      )
      .argument("<automation>", "Workflow automation ID")
      .option("--expr <expression>", 'New cron schedule (e.g. "0 9 * * *")')
      .option("--at <iso-time>", 'New one-time fire (e.g. "2026-06-10T09:00")')
      .option("--every <duration>", "New loop interval (e.g. 15m, 1h, 90s)")
      .option("-z, --timezone <tz>", "IANA timezone for --expr / --at"),
  ),
)
  .addHelpText(
    "after",
    `
Examples:
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --expr "0 9 * * *" -z Asia/Shanghai
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --at "2026-06-10T09:00" -z UTC
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --every 10m
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --from-contains "@example.com"
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --config ./gmail-automation.json
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --label "Support"
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --actor anyone
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --conclusion failure,timed_out --branch main
  zero workflow automation update 22222222-2222-4222-8222-222222222222 --actor any`,
  )
  .action(
    withErrorHandler(async (id: string, options: UpdateOptions) => {
      const existing = await getWorkflowAutomation(id);
      const body = buildUpdate(options, existing);
      const automation = await updateWorkflowAutomation(id, body);

      console.log(chalk.green(`✓ Automation ${automation.id} updated`));
      const threadModel =
        await tryLoadWorkflowAutomationThreadModel(automation);
      printWorkflowAutomationDetails(automation, { threadModel });
    }),
  );

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List a workflow's automations")
  .argument("<workflow>", "Workflow ID or name")
  .option("--agent <id>", "Agent ID for resolving a workflow name")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow automation list tell-a-joke --agent <agent-id>
  zero workflow automation list <workflow-id>`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string, options: WorkflowRefOptions) => {
        const workflowId = await resolveWorkflowRef(workflowRef, options);
        const automations = await listWorkflowAutomations(workflowId);

        if (automations.length === 0) {
          console.log(chalk.dim("No automations"));
          console.log(
            chalk.dim(
              `  Add one with: zero workflow automation add ${workflowRef} cron --expr "0 9 * * *"`,
            ),
          );
          return;
        }

        printWorkflowAutomationsTable(automations);
      },
    ),
  );

const showCommand = new Command()
  .name("show")
  .description("Show a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      const automation = await getWorkflowAutomation(id);
      const entries = await listWorkspaceWorkflowAutomations();
      const entry = entries.find(({ automation }) => {
        return automation.id === id;
      });
      if (!entry) {
        printWorkflowAutomationDetails(automation);
        return;
      }
      const threadModel = await loadWorkflowAutomationThreadModel(
        entry.automation,
      );
      printWorkflowAutomationDetails(entry.automation, {
        workflowRef: entry.workflow.name,
        workflowId: entry.workflow.id,
        threadModel,
      });
    }),
  );

const rmCommand = new Command()
  .name("rm")
  .alias("remove")
  .description("Remove a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      await deleteWorkflowAutomation(id);
      console.log(chalk.green(`✓ Automation ${id} removed`));
    }),
  );

const enableCommand = new Command()
  .name("enable")
  .description("Enable a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      const automation = await enableWorkflowAutomation(id);
      console.log(chalk.green(`✓ Automation ${automation.id} enabled`));
      const threadModel =
        await tryLoadWorkflowAutomationThreadModel(automation);
      printWorkflowAutomationThreadModel(threadModel);
    }),
  );

const disableCommand = new Command()
  .name("disable")
  .description("Disable a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      const automation = await disableWorkflowAutomation(id);
      console.log(chalk.green(`✓ Automation ${automation.id} disabled`));
      const threadModel =
        await tryLoadWorkflowAutomationThreadModel(automation);
      printWorkflowAutomationThreadModel(threadModel);
    }),
  );

export const automationCommand = new Command()
  .name("automation")
  .description("Manage a workflow's automations")
  .addCommand(addCommand)
  .addCommand(updateCommand)
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(rmCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addHelpText(
    "after",
    `
Examples:
  Add an automation:     zero workflow automation add <workflow-id> cron --expr "0 9 * * *"
  Add a Notion page:     zero workflow automation add <workflow-id> notion-child-page-created --parent-page-url "https://www.notion.so/..."
  Add a webhook:         zero workflow automation add <workflow-id> webhook
  Update a schedule:     zero workflow automation update <automation-id> --every 10m
  List automations:      zero workflow automation list <workflow-id>
  Inspect an automation: zero workflow automation show <automation-id>
  Pause one automation:  zero workflow automation disable <automation-id>`,
  );
