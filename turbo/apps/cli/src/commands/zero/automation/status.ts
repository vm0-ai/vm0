import { Command } from "commander";
import chalk from "chalk";
import { resolveZeroAutomationByAgent } from "../../../lib/api";
import {
  formatDateTime,
  detectTimezone,
} from "../../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../../lib/command";
import type { AutomationResponse } from "@vm0/api-contracts/contracts/automations";

/**
 * Format date with styled relative time (adds chalk formatting)
 */
function formatDateTimeStyled(dateStr: string | null): string {
  if (!dateStr) return chalk.dim("-");
  const formatted = formatDateTime(dateStr);
  return formatted.replace(/\(([^)]+)\)$/, chalk.dim("($1)"));
}

/**
 * Format trigger (cron or at) - timezone shown separately
 */
function formatTrigger(automation: AutomationResponse): string {
  if (
    automation.triggerType === "loop" &&
    automation.intervalSeconds !== null
  ) {
    return `interval ${automation.intervalSeconds}s ${chalk.dim("(loop)")}`;
  }
  if (automation.cronExpression) {
    return automation.cronExpression;
  }
  if (automation.atTime) {
    return `${automation.atTime} ${chalk.dim("(one-time)")}`;
  }
  return chalk.dim("-");
}

/**
 * Print run configuration section
 */
function printRunConfiguration(
  automation: AutomationResponse,
  showFullPrompt: boolean,
): void {
  const statusText = automation.enabled
    ? chalk.green("enabled")
    : chalk.yellow("disabled");
  console.log(`${"Status:".padEnd(16)}${statusText}`);

  console.log(`${"Agent:".padEnd(16)}${automation.agentId}`);

  if (showFullPrompt) {
    console.log(`${"Prompt:".padEnd(16)}${chalk.dim(automation.prompt)}`);
  } else {
    const truncated = automation.prompt.length > 60;
    const promptPreview = truncated
      ? automation.prompt.slice(0, 57) + "..."
      : automation.prompt;
    console.log(`${"Prompt:".padEnd(16)}${chalk.dim(promptPreview)}`);
    if (truncated) {
      console.log(
        chalk.dim("                Run with --prompt (-p) to see full prompt"),
      );
    }
  }
}

/**
 * Print time schedule section
 */
function printTimeSchedule(automation: AutomationResponse): void {
  console.log();
  console.log(`${"Trigger:".padEnd(16)}${formatTrigger(automation)}`);
  console.log(`${"Timezone:".padEnd(16)}${detectTimezone()}`);

  if (automation.enabled) {
    console.log(
      `${"Next Run:".padEnd(16)}${formatDateTimeStyled(automation.nextRunAt)}`,
    );
  }

  if (automation.triggerType === "loop" || automation.triggerType === "cron") {
    const failureText =
      automation.consecutiveFailures > 0
        ? chalk.yellow(`${automation.consecutiveFailures}/3`)
        : chalk.dim("0/3");
    console.log(`${"Failures:".padEnd(16)}${failureText}`);
  }
}

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a zero automation")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <automation-name>",
    "Automation name (required when agent has multiple automations)",
  )
  .option("-p, --prompt", "Show full prompt content without truncation")
  .addHelpText(
    "after",
    `
Examples:
  zero automation status <agent-id>
  zero automation status <agent-id> -n my-automation
  zero automation status <agent-id> --prompt`,
  )
  .action(
    withErrorHandler(
      async (
        agentName: string,
        options: { name?: string; prompt?: boolean },
      ) => {
        const automation = await resolveZeroAutomationByAgent(
          agentName,
          options.name,
        );

        console.log();
        console.log(`Automation for agent: ${chalk.cyan(agentName)}`);
        console.log(chalk.dim("━".repeat(50)));

        printRunConfiguration(automation, options.prompt ?? false);
        printTimeSchedule(automation);

        console.log();
      },
    ),
  );
