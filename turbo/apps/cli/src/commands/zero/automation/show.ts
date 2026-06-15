import { Command } from "commander";
import chalk from "chalk";
import { showAutomation } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printTriggersTable } from "./trigger-display";

export const showCommand = new Command()
  .name("show")
  .description("Show an automation and its triggers")
  .argument("<automation>", "Automation ID or name")
  .addHelpText(
    "after",
    `
Examples:
  zero automation show alerts
  zero automation show 11111111-1111-4111-8111-111111111111

Notes:
  - When the same name exists on multiple agents, the API rejects it as ambiguous — use the ID`,
  )
  .action(
    withErrorHandler(async (ref: string) => {
      const automation = await showAutomation(ref);

      const status = automation.enabled
        ? chalk.green("enabled")
        : chalk.yellow("disabled");
      const agent = automation.displayName
        ? `${automation.displayName} ${chalk.dim(`(${automation.agentId})`)}`
        : automation.agentId;

      console.log(`${"Name:".padEnd(14)}${automation.name}`);
      console.log(`${"ID:".padEnd(14)}${automation.id}`);
      console.log(`${"Agent:".padEnd(14)}${agent}`);
      console.log(`${"Status:".padEnd(14)}${status}`);
      if (automation.description) {
        console.log(`${"Description:".padEnd(14)}${automation.description}`);
      }
      console.log(
        `${"Instruction:".padEnd(14)}${chalk.dim(automation.instruction)}`,
      );
      console.log(`${"Thread:".padEnd(14)}${automation.chatThreadId}`);

      console.log();
      if (automation.triggers.length === 0) {
        console.log(chalk.dim("No triggers"));
        console.log(
          chalk.dim(
            `  Add one with: zero automation trigger add ${automation.name} cron --expr "0 9 * * *"`,
          ),
        );
        return;
      }

      printTriggersTable(automation.triggers);
    }),
  );
