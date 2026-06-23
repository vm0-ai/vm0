import chalk from "chalk";
import type { AutomationTriggerResponse } from "@vm0/api-contracts/contracts/automations";
import { formatRelativeTime } from "../../../lib/domain/schedule-utils";
import { formatDurationSeconds } from "./duration";

/**
 * Shared rendering for automation triggers: the triggers table used by
 * `automation list/show` and `trigger list`.
 */

/** One-line config summary per trigger kind. */
export function formatTriggerConfig(
  trigger: AutomationTriggerResponse,
): string {
  switch (trigger.kind) {
    case "cron":
      return `${trigger.cronExpression} (${trigger.timezone})`;
    case "once":
      return `at ${trigger.atTime} (${trigger.timezone})`;
    case "loop":
      return `every ${formatDurationSeconds(trigger.intervalSeconds)}`;
  }
}

function formatNextRun(trigger: AutomationTriggerResponse): string {
  if (!trigger.nextRunAt) {
    return chalk.dim("-");
  }
  return formatRelativeTime(trigger.nextRunAt);
}

/**
 * Print the triggers table: KIND, ID, STATUS, CONFIG, NEXT RUN
 */
export function printTriggersTable(
  triggers: readonly AutomationTriggerResponse[],
): void {
  const kindWidth = Math.max(
    4,
    ...triggers.map((t) => {
      return t.kind.length;
    }),
  );
  const idWidth = Math.max(
    2,
    ...triggers.map((t) => {
      return t.id.length;
    }),
  );
  const configWidth = Math.max(
    6,
    ...triggers.map((t) => {
      return formatTriggerConfig(t).length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "KIND".padEnd(kindWidth),
        "ID".padEnd(idWidth),
        "STATUS".padEnd(8),
        "CONFIG".padEnd(configWidth),
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
        trigger.kind.padEnd(kindWidth),
        trigger.id.padEnd(idWidth),
        status.padEnd(8 + (trigger.enabled ? 0 : 2)),
        formatTriggerConfig(trigger).padEnd(configWidth),
        formatNextRun(trigger),
      ].join("  "),
    );
  }
}

/**
 * Print detail lines for a single trigger (used by `trigger add/show`)
 */
export function printTriggerDetails(trigger: AutomationTriggerResponse): void {
  const status = trigger.enabled
    ? chalk.green("enabled")
    : chalk.yellow("disabled");

  console.log(`${"Kind:".padEnd(14)}${trigger.kind}`);
  console.log(`${"ID:".padEnd(14)}${trigger.id}`);
  console.log(`${"Automation:".padEnd(14)}${trigger.automationId}`);
  console.log(`${"Status:".padEnd(14)}${status}`);

  switch (trigger.kind) {
    case "cron":
      console.log(`${"Cron:".padEnd(14)}${trigger.cronExpression}`);
      break;
    case "once":
      console.log(`${"At:".padEnd(14)}${trigger.atTime}`);
      break;
    case "loop":
      console.log(
        `${"Every:".padEnd(14)}${formatDurationSeconds(trigger.intervalSeconds)}`,
      );
      break;
  }

  console.log(`${"Timezone:".padEnd(14)}${trigger.timezone}`);
  console.log(
    `${"Next run:".padEnd(14)}${
      trigger.nextRunAt ? formatRelativeTime(trigger.nextRunAt) : chalk.dim("-")
    }`,
  );
  console.log(
    `${"Last run:".padEnd(14)}${
      trigger.lastRunAt ? formatRelativeTime(trigger.lastRunAt) : chalk.dim("-")
    }`,
  );
}
