import { Command } from "commander";
import chalk from "chalk";
import type {
  ZeroWorkflowSchedule,
  ZeroWorkflowTriggerCreateRequest,
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
  runWorkflowTrigger,
  updateWorkflowTrigger,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { parseDurationSeconds } from "../../automation/duration";
import {
  printWorkflowTriggerDetails,
  printWorkflowTriggersTable,
} from "./display";

interface AddOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
  readonly agent?: string;
}

interface UpdateOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
}

interface WorkflowRefOptions {
  readonly agent?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEDULE_KINDS = ["cron", "once", "loop"] as const;
const EXACTLY_ONE_FLAG_MESSAGE =
  "Provide exactly one of --expr (cron), --at (once), --every (loop)";

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
        `Unknown trigger kind: "${kind}". Use one of: ${SCHEDULE_KINDS.join(", ")}`,
      );
  }
}

function buildUpdate(options: UpdateOptions): ZeroWorkflowTriggerUpdateRequest {
  const flagCount = [options.expr, options.at, options.every].filter(
    (value) => {
      return value !== undefined;
    },
  ).length;
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

const addCommand = new Command()
  .name("add")
  .description("Add a schedule trigger to a workflow")
  .argument("<workflow>", "Workflow ID or name")
  .argument("<kind>", `Trigger kind: ${SCHEDULE_KINDS.join(" | ")}`)
  .option("--expr <expression>", 'Cron expression for kind "cron"')
  .option("--at <iso-time>", 'Fire time for kind "once"')
  .option("--every <duration>", 'Interval for kind "loop" (e.g. 15m, 1h, 90s)')
  .option("-z, --timezone <tz>", "IANA timezone for cron/once (default: UTC)")
  .option("--agent <id>", "Agent ID for resolving a workflow name")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow trigger add tell-a-joke cron --expr "0 9 * * *" -z Asia/Shanghai
  zero workflow trigger add tell-a-joke once --at "2026-06-10T09:00" -z Asia/Shanghai
  zero workflow trigger add tell-a-joke loop --every 15m

Notes:
  - Workflow names resolve under --agent, then ZERO_AGENT_ID, then all visible workflows
  - Use the workflow ID when a name is ambiguous`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string, kind: string, options: AddOptions) => {
        if (options.timezone && kind !== "cron" && kind !== "once") {
          throw new Error("--timezone only applies to cron and once triggers");
        }
        const workflowId = await resolveWorkflowId(workflowRef, options);
        const body: ZeroWorkflowTriggerCreateRequest = {
          schedule: buildSchedule(kind, options),
        };
        const trigger = await createWorkflowTrigger(workflowId, body);

        console.log(
          chalk.green(`✓ Trigger added to workflow "${workflowRef}"`),
        );
        printWorkflowTriggerDetails(trigger, { workflowRef });
      },
    ),
  );

const updateCommand = new Command()
  .name("update")
  .description("Replace a workflow trigger's schedule")
  .argument("<trigger>", "Workflow trigger ID")
  .option("--expr <expression>", 'New cron schedule (e.g. "0 9 * * *")')
  .option("--at <iso-time>", 'New one-time fire (e.g. "2026-06-10T09:00")')
  .option("--every <duration>", "New loop interval (e.g. 15m, 1h, 90s)")
  .option("-z, --timezone <tz>", "IANA timezone for --expr / --at")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --expr "0 9 * * *" -z Asia/Shanghai
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --at "2026-06-10T09:00" -z UTC
  zero workflow trigger update 22222222-2222-4222-8222-222222222222 --every 10m`,
  )
  .action(
    withErrorHandler(async (id: string, options: UpdateOptions) => {
      const trigger = await updateWorkflowTrigger(id, buildUpdate(options));

      console.log(chalk.green(`✓ Trigger ${trigger.id} updated`));
      printWorkflowTriggerDetails(trigger);
    }),
  );

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List a workflow's schedule triggers")
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

const runCommand = new Command()
  .name("run")
  .description("Fire a workflow trigger test run")
  .argument("<trigger>", "Workflow trigger ID")
  .action(
    withErrorHandler(async (id: string) => {
      const result = await runWorkflowTrigger(id);
      console.log(chalk.green(`✓ Workflow trigger ${id} run started`));
      console.log(`  Run ID:        ${result.runId}`);
      console.log();
      console.log(`Stream logs: zero logs ${result.runId}`);
    }),
  );

export const triggerCommand = new Command()
  .name("trigger")
  .description("Manage a workflow's schedule triggers")
  .addCommand(addCommand)
  .addCommand(updateCommand)
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(rmCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(runCommand)
  .addHelpText(
    "after",
    `
Examples:
  Add a trigger:      zero workflow trigger add <workflow> cron --expr "0 9 * * *"
  Update a schedule:  zero workflow trigger update <trigger-id> --every 10m
  List triggers:      zero workflow trigger list <workflow>
  Inspect a trigger:  zero workflow trigger show <trigger-id>
  Test run:           zero workflow trigger run <trigger-id>
  Pause one trigger:  zero workflow trigger disable <trigger-id>`,
  );
