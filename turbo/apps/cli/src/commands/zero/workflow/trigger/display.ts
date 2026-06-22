import chalk from "chalk";
import type { ZeroWorkflowTriggerSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { formatRelativeTime } from "../../../../lib/domain/schedule-utils";
import { formatDurationSeconds } from "../../automation/duration";

function formatWorkflowTriggerSchedule(
  trigger: ZeroWorkflowTriggerSummary,
): string {
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
    8,
    ...triggers.map((trigger) => {
      return formatWorkflowTriggerSchedule(trigger).length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "ID".padEnd(idWidth),
        "STATUS".padEnd(8),
        "SCHEDULE".padEnd(scheduleWidth),
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
        formatWorkflowTriggerSchedule(trigger).padEnd(scheduleWidth),
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
    `${"Schedule:".padEnd(14)}${formatWorkflowTriggerSchedule(trigger)}`,
  );
  console.log(`${"Owner:".padEnd(14)}${trigger.ownerUserId}`);
  console.log(
    `${"Chat thread:".padEnd(14)}${trigger.chatThreadId ?? chalk.dim("-")}`,
  );
  console.log(`${"Next run:".padEnd(14)}${formatRunTime(trigger.nextRunAt)}`);
  console.log(`${"Last run:".padEnd(14)}${formatRunTime(trigger.lastRunAt)}`);
}
