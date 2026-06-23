import { Command } from "commander";
import chalk from "chalk";
import type { AutomationResponse } from "@vm0/api-contracts/contracts/automations";
import { listAutomations } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function formatTriggerSummary(automation: AutomationResponse): string {
  const [trigger] = automation.triggers;
  if (!trigger) {
    return chalk.dim("-");
  }
  return trigger.kind;
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List automations with their schedule trigger")
  .addHelpText(
    "after",
    `
Examples:
  zero automation list`,
  )
  .action(
    withErrorHandler(async () => {
      const { automations } = await listAutomations();

      if (automations.length === 0) {
        console.log(chalk.dim("No automations found"));
        console.log(
          chalk.dim(
            '  Create one with: zero automation create -n <name> --agent <agent-id> -p "<instruction>"',
          ),
        );
        return;
      }

      const nameWidth = Math.max(
        4,
        ...automations.map((a) => {
          return a.name.length;
        }),
      );
      const idWidth = Math.max(
        2,
        ...automations.map((a) => {
          return a.id.length;
        }),
      );
      const agentWidth = Math.max(
        5,
        ...automations.map((a) => {
          return (a.displayName ?? a.agentId).length;
        }),
      );

      console.log(
        chalk.dim(
          [
            "NAME".padEnd(nameWidth),
            "ID".padEnd(idWidth),
            "AGENT".padEnd(agentWidth),
            "STATUS".padEnd(8),
            "TRIGGER",
          ].join("  "),
        ),
      );

      for (const automation of automations) {
        const status = automation.enabled
          ? chalk.green("enabled")
          : chalk.yellow("disabled");
        console.log(
          [
            automation.name.padEnd(nameWidth),
            automation.id.padEnd(idWidth),
            (automation.displayName ?? automation.agentId).padEnd(agentWidth),
            status.padEnd(8 + (automation.enabled ? 0 : 2)),
            formatTriggerSummary(automation),
          ].join("  "),
        );
      }

      console.log();
      console.log(
        chalk.dim(`  Details: zero automation show <automation-name-or-id>`),
      );
    }),
  );
