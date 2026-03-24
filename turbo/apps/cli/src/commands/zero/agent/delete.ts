import { Command } from "commander";
import chalk from "chalk";
import { getZeroAgent, deleteZeroAgent } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a zero agent")
  .argument("<agent-id>", "Agent ID")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(async (agentId: string, options: { yes?: boolean }) => {
      await getZeroAgent(agentId);

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }
        const confirmed = await promptConfirm(
          `Delete zero agent '${agentId}'?`,
          false,
        );
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteZeroAgent(agentId);
      console.log(chalk.green(`✓ Zero agent '${agentId}' deleted`));
    }),
  );
