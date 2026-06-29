import { Command } from "commander";
import chalk from "chalk";
import type {
  GithubLabelAppliedSubjectFilter,
  ZeroWorkflowSchedule,
  ZeroWorkflowTriggerCreateRequest,
  ZeroWorkflowTriggerSummary,
  ZeroWorkflowTriggerUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  disableWorkflowTrigger,
  enableWorkflowTrigger,
  getWorkflowTrigger,
  listWorkflowTriggers,
  listWorkflows,
  updateWorkflowTrigger,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { parseDurationSeconds } from "../../automation/duration";
import {
  printWorkflowTriggerDetails,
  printWorkflowTriggersTable,
} from "./display";
import {
  buildGmailLabelAppliedEventConfig,
  buildGmailNewMessageEventConfig,
  hasGmailLabelOption,
  hasGmailTriggerOptions,
  type GmailTriggerOptions,
} from "./gmail-config";

interface AddOptions extends GmailTriggerOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
  readonly agent?: string;
  readonly subject?: string;
  readonly actor?: string;
  readonly calendarId?: string;
}

interface UpdateOptions extends GmailTriggerOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
  readonly subject?: string;
  readonly actor?: string;
}

interface WorkflowRefOptions {
  readonly agent?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEDULE_KINDS = ["cron", "once", "loop"] as const;
const EVENT_KINDS = [
  "gmail-new-message",
  "gmail-label-applied",
  "github-label-applied",
  "google-calendar-event-created",
  "webhook",
] as const;
const TRIGGER_KINDS = [...SCHEDULE_KINDS, ...EVENT_KINDS] as const;
const EXACTLY_ONE_FLAG_MESSAGE =
  "Provide exactly one of --expr (cron), --at (once), --every (loop), Gmail match options, --label, --subject, or --actor";

function addGmailTriggerOptions(command: Command): Command {
  return command
    .option(
      "--config <path>",
      "Path to a Gmail new message trigger config JSON",
    )
    .option("--label <name>", "Label name for label-applied triggers")
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

function addGithubTriggerOptions(command: Command): Command {
  return command
    .option(
      "--subject <subject>",
      "GitHub subject filter for github-label-applied: both | issues | pull-requests",
    )
    .option(
      "--actor <actor>",
      "GitHub actor filter for github-label-applied: me | anyone",
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
          'cron triggers require --expr (e.g. --expr "0 9 * * *")',
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
          'once triggers require --at (e.g. --at "2026-06-10T09:00")',
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
        throw new Error("loop triggers require --every (e.g. --every 15m)");
      }
      return {
        type: "loop",
        intervalSeconds: parseDurationSeconds(options.every),
      };
    default:
      throw new Error(
        `Unknown trigger kind: "${kind}". Use one of: ${TRIGGER_KINDS.join(", ")}`,
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

function hasGithubTriggerOptions(options: AddOptions | UpdateOptions): boolean {
  return options.subject !== undefined || options.actor !== undefined;
}

function hasCalendarTriggerOptions(options: AddOptions): boolean {
  return options.calendarId !== undefined;
}

function hasEventAddOptions(options: AddOptions): boolean {
  return (
    hasGmailTriggerOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubTriggerOptions(options) ||
    hasCalendarTriggerOptions(options)
  );
}

function assertNoScheduleAddOptions(options: AddOptions): void {
  if (hasScheduleAddOptions(options)) {
    throw new Error(
      "--expr, --at, --every, and --timezone only apply to schedule triggers",
    );
  }
}

function assertNoGithubTriggerOptions(
  options: AddOptions,
  message = "GitHub trigger flags only apply to GitHub event triggers",
): void {
  if (hasGithubTriggerOptions(options)) {
    throw new Error(message);
  }
}

function assertNoCalendarTriggerOptions(options: AddOptions): void {
  if (hasCalendarTriggerOptions(options)) {
    throw new Error(
      "Google Calendar trigger flags only apply to Google Calendar event triggers",
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
    ZeroWorkflowTriggerSummary,
    { readonly kind: "event"; readonly eventType: "github-label-applied" }
  >,
) {
  const labelName = options.label?.trim() ?? existing?.eventConfig.labelName;
  if (!labelName) {
    throw new Error(
      'github-label-applied triggers require --label "Label name"',
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

function buildGmailNewMessageCreateRequest(
  options: AddOptions,
): ZeroWorkflowTriggerCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailLabelOption(options)) {
    throw new Error("--label only applies to label-applied event triggers");
  }
  assertNoGithubTriggerOptions(options);
  assertNoCalendarTriggerOptions(options);
  return {
    kind: "event",
    eventType: "gmail-new-message",
    eventConfig: buildGmailNewMessageEventConfig(options),
  };
}

function buildGmailLabelAppliedCreateRequest(
  options: AddOptions,
): ZeroWorkflowTriggerCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailTriggerOptions(options)) {
    throw new Error(
      "Gmail match flags and --config only apply to gmail-new-message triggers",
    );
  }
  assertNoGithubTriggerOptions(options);
  assertNoCalendarTriggerOptions(options);
  return {
    kind: "event",
    eventType: "gmail-label-applied",
    eventConfig: buildGmailLabelAppliedEventConfig(options),
  };
}

function buildGithubLabelAppliedCreateRequest(
  options: AddOptions,
): ZeroWorkflowTriggerCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailTriggerOptions(options)) {
    throw new Error(
      "Gmail match flags and --config only apply to Gmail event triggers",
    );
  }
  assertNoCalendarTriggerOptions(options);
  return {
    kind: "event",
    eventType: "github-label-applied",
    eventConfig: buildGithubLabelAppliedEventConfig(options),
  };
}

function buildGoogleCalendarEventCreatedCreateRequest(
  options: AddOptions,
): ZeroWorkflowTriggerCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailTriggerOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubTriggerOptions(options)
  ) {
    throw new Error(
      "Gmail and GitHub trigger flags only apply to their event triggers",
    );
  }
  return {
    kind: "event",
    eventType: "google-calendar-event-created",
    eventConfig: {
      provider: "google-calendar",
      event: "event_created",
      calendarId: options.calendarId?.trim() || "primary",
    },
  };
}

function buildWebhookCreateRequest(
  options: AddOptions,
): ZeroWorkflowTriggerCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasEventAddOptions(options)) {
    throw new Error("Event trigger flags only apply to event triggers");
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

function buildScheduleCreateRequest(
  kind: string,
  options: AddOptions,
): ZeroWorkflowTriggerCreateRequest {
  if (hasEventAddOptions(options)) {
    throw new Error("Event trigger flags only apply to event triggers");
  }
  return { schedule: buildSchedule(kind, options) };
}

function buildCreateRequest(
  kind: string,
  options: AddOptions,
): ZeroWorkflowTriggerCreateRequest {
  switch (kind) {
    case "gmail-new-message":
      return buildGmailNewMessageCreateRequest(options);
    case "gmail-label-applied":
      return buildGmailLabelAppliedCreateRequest(options);
    case "github-label-applied":
      return buildGithubLabelAppliedCreateRequest(options);
    case "google-calendar-event-created":
      return buildGoogleCalendarEventCreatedCreateRequest(options);
    case "webhook":
      return buildWebhookCreateRequest(options);
    default:
      return buildScheduleCreateRequest(kind, options);
  }
}

function buildEventUpdate(
  options: UpdateOptions,
  existing: Extract<ZeroWorkflowTriggerSummary, { readonly kind: "event" }>,
): ZeroWorkflowTriggerUpdateRequest {
  const hasGmailOptions = hasGmailTriggerOptions(options);
  const hasLabelOption = hasGmailLabelOption(options);
  const hasGithubOptions = hasGithubTriggerOptions(options);

  if (existing.eventType === "google-calendar-event-created") {
    throw new Error("Google Calendar event triggers cannot be updated");
  }

  if (existing.eventType === "github-label-applied") {
    if (hasGmailOptions) {
      throw new Error("Gmail match flags only apply to Gmail event triggers");
    }
    if (!hasLabelOption && !hasGithubOptions) {
      throw new Error(
        "Provide --label, --subject, or --actor for github-label-applied triggers",
      );
    }
    return {
      eventConfig: buildGithubLabelAppliedEventConfig(options, existing),
    };
  }

  if (hasGithubOptions) {
    throw new Error("GitHub trigger flags only apply to GitHub event triggers");
  }

  if (existing.eventType === "gmail-label-applied") {
    if (!hasLabelOption || hasGmailOptions) {
      throw new Error("Use --label for gmail-label-applied triggers");
    }
    return { eventConfig: buildGmailLabelAppliedEventConfig(options) };
  }

  if (!hasGmailOptions || hasLabelOption) {
    throw new Error("Use Gmail match options for gmail-new-message triggers");
  }
  return { eventConfig: buildGmailNewMessageEventConfig(options) };
}

function buildScheduleUpdate(
  options: UpdateOptions,
): ZeroWorkflowTriggerUpdateRequest {
  const hasGmailOptions = hasGmailTriggerOptions(options);
  const hasLabelOption = hasGmailLabelOption(options);
  if (hasGmailOptions || hasLabelOption) {
    throw new Error("Gmail trigger flags only apply to Gmail event triggers");
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
  existing: ZeroWorkflowTriggerSummary,
): ZeroWorkflowTriggerUpdateRequest {
  const hasEventOptions =
    hasGmailTriggerOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubTriggerOptions(options);
  if (hasScheduleUpdateOptions(options) && hasEventOptions) {
    throw new Error("Use either schedule flags or event trigger options");
  }
  if (hasGmailTriggerOptions(options) && hasGmailLabelOption(options)) {
    throw new Error("Use either Gmail match options or --label");
  }

  if (existing.kind === "event") {
    if (hasScheduleUpdateOptions(options)) {
      throw new Error("Schedule flags only apply to schedule triggers");
    }
    return buildEventUpdate(options, existing);
  }

  if (hasGithubTriggerOptions(options)) {
    throw new Error("GitHub trigger flags only apply to GitHub event triggers");
  }
  return buildScheduleUpdate(options);
}

async function resolveWorkflowId(
  ref: string,
  options: WorkflowRefOptions,
): Promise<string> {
  if (UUID_RE.test(ref)) {
    return ref;
  }

  const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
  const workflows = await listWorkflows(agentId ? { agentId } : {});
  const matches = workflows.filter((workflow) => {
    return workflow.name === ref;
  });
  if (matches.length === 0) {
    const hint = agentId
      ? ` under agent "${agentId}"`
      : ". Provide --agent <agent-id> or use the workflow ID";
    throw new Error(`Workflow not found: "${ref}"${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous workflow name: "${ref}". Provide --agent <agent-id> or use the workflow ID`,
    );
  }
  return matches[0]!.id;
}

const addCommand = addGithubTriggerOptions(
  addGmailTriggerOptions(
    new Command()
      .name("add")
      .description("Add a trigger to a workflow")
      .argument("<workflow>", "Workflow ID or name")
      .argument("<kind>", `Trigger type: ${TRIGGER_KINDS.join(" | ")}`)
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
    "Google Calendar ID for google-calendar-event-created (default: primary)",
  )
  .option("--agent <id>", "Agent ID for resolving a workflow name")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow trigger add tell-a-joke cron --expr "0 9 * * *" -z Asia/Shanghai
  zero workflow trigger add tell-a-joke once --at "2026-06-10T09:00" -z Asia/Shanghai
  zero workflow trigger add tell-a-joke loop --every 15m
  zero workflow trigger add triage gmail-new-message --from-contains "@example.com"
  zero workflow trigger add triage gmail-new-message --config ./gmail-trigger.json
  zero workflow trigger add triage gmail-label-applied --label "Support"
  zero workflow trigger add triage github-label-applied --label "triage" --subject both --actor me
  zero workflow trigger add triage google-calendar-event-created
  zero workflow trigger add triage webhook

Notes:
  - Workflow names resolve under --agent, then ZERO_AGENT_ID, then all visible workflows
  - Gmail triggers match all inbound messages when no text match rules are provided
  - GitHub label triggers require the GitHub App installation in the workspace
  - Webhook triggers print the signing secret only once after creation
  - Use the workflow ID when a name is ambiguous`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string, kind: string, options: AddOptions) => {
        if (
          options.timezone &&
          kind !== "cron" &&
          kind !== "once" &&
          kind !== "gmail-new-message"
        ) {
          throw new Error("--timezone only applies to cron and once triggers");
        }
        const workflowId = await resolveWorkflowId(workflowRef, options);
        const body = buildCreateRequest(kind, options);
        const trigger = await createWorkflowTrigger(workflowId, body);

        console.log(
          chalk.green(`✓ Trigger added to workflow "${workflowRef}"`),
        );
        printWorkflowTriggerDetails(trigger, { workflowRef });
      },
    ),
  );

const updateCommand = addGithubTriggerOptions(
  addGmailTriggerOptions(
    new Command()
      .name("update")
      .description(
        "Replace a workflow trigger's schedule or Gmail match config",
      )
      .argument("<trigger>", "Workflow trigger ID")
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
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --expr "0 9 * * *" -z Asia/Shanghai
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --at "2026-06-10T09:00" -z UTC
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --every 10m
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --from-contains "@example.com"
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --config ./gmail-trigger.json
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --label "Support"
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --actor anyone`,
  )
  .action(
    withErrorHandler(async (id: string, options: UpdateOptions) => {
      const existing = await getWorkflowTrigger(id);
      const trigger = await updateWorkflowTrigger(
        id,
        buildUpdate(options, existing),
      );

      console.log(chalk.green(`✓ Trigger ${trigger.id} updated`));
      printWorkflowTriggerDetails(trigger);
    }),
  );

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List a workflow's triggers")
  .argument("<workflow>", "Workflow ID or name")
  .option("--agent <id>", "Agent ID for resolving a workflow name")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow trigger list tell-a-joke
  zero workflow trigger list tell-a-joke --agent <agent-id>`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string, options: WorkflowRefOptions) => {
        const workflowId = await resolveWorkflowId(workflowRef, options);
        const triggers = await listWorkflowTriggers(workflowId);

        if (triggers.length === 0) {
          console.log(chalk.dim("No triggers"));
          console.log(
            chalk.dim(
              `  Add one with: zero workflow trigger add ${workflowRef} cron --expr "0 9 * * *"`,
            ),
          );
          return;
        }

        printWorkflowTriggersTable(triggers);
      },
    ),
  );

const showCommand = new Command()
  .name("show")
  .description("Show a workflow trigger")
  .argument("<trigger>", "Workflow trigger ID")
  .action(
    withErrorHandler(async (id: string) => {
      const trigger = await getWorkflowTrigger(id);
      printWorkflowTriggerDetails(trigger);
    }),
  );

const rmCommand = new Command()
  .name("rm")
  .alias("remove")
  .description("Remove a workflow trigger")
  .argument("<trigger>", "Workflow trigger ID")
  .action(
    withErrorHandler(async (id: string) => {
      await deleteWorkflowTrigger(id);
      console.log(chalk.green(`✓ Trigger ${id} removed`));
    }),
  );

const enableCommand = new Command()
  .name("enable")
  .description("Enable a workflow trigger")
  .argument("<trigger>", "Workflow trigger ID")
  .action(
    withErrorHandler(async (id: string) => {
      const trigger = await enableWorkflowTrigger(id);
      console.log(chalk.green(`✓ Trigger ${trigger.id} enabled`));
    }),
  );

const disableCommand = new Command()
  .name("disable")
  .description("Disable a workflow trigger")
  .argument("<trigger>", "Workflow trigger ID")
  .action(
    withErrorHandler(async (id: string) => {
      const trigger = await disableWorkflowTrigger(id);
      console.log(chalk.green(`✓ Trigger ${trigger.id} disabled`));
    }),
  );

export const triggerCommand = new Command()
  .name("trigger")
  .description("Manage a workflow's triggers")
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
  Add a trigger:      zero workflow trigger add <workflow> cron --expr "0 9 * * *"
  Add a webhook:      zero workflow trigger add <workflow> webhook
  Update a schedule:  zero workflow trigger update <trigger-id> --every 10m
  List triggers:      zero workflow trigger list <workflow>
  Inspect a trigger:  zero workflow trigger show <trigger-id>
  Pause one trigger:  zero workflow trigger disable <trigger-id>`,
  );
