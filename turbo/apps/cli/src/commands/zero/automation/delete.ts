import { Command } from "commander";
import chalk from "chalk";
import {
  deleteZeroAutomation,
  resolveZeroAutomationByAgent,
} from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a zero automation")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <automation-name>",
    "Automation name (required when agent has multiple automations)",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Examples:
  zero automation delete <agent-id>
  zero automation delete <agent-id> -n my-automation -y

Notes:
  - Use -y to skip confirmation in non-interactive mode`,
  )
  .action(
    withErrorHandler(
      async (agentName: string, options: { name?: string; yes?: boolean }) => {
        const resolved = await resolveZeroAutomationByAgent(
          agentName,
          options.name,
        );

        if (!options.yes) {
          if (!isInteractive()) {
            throw new Error("--yes flag is required in non-interactive mode");
          }
          const confirmed = await promptConfirm(
            `Delete automation for agent ${chalk.cyan(agentName)}?`,
            false,
          );
          if (!confirmed) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        await deleteZeroAutomation({
          name: resolved.name,
          agentId: resolved.agentId,
        });

        console.log(chalk.green(`✓ Automation "${resolved.name}" deleted`));
      },
    ),
  );
