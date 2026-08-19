import { Command } from "commander";
import chalk from "chalk";
import { getAgent, deleteAgent } from "../../lib/api/domains/agents";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete an agent")
  .argument("<agent-id>", "Agent ID")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Examples:
  okou agent delete <agent-id>
  okou agent delete <agent-id> -y

Notes:
  - Use -y to skip confirmation in non-interactive mode`,
  )
  .action(
    withErrorHandler(async (agentId: string, options: { yes?: boolean }) => {
      await getAgent(agentId);

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }
        const confirmed = await promptConfirm(
          `Delete agent '${agentId}'?`,
          false,
        );
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteAgent(agentId);
      console.log(chalk.green(`✓ Agent "${agentId}" deleted`));
    }),
  );
