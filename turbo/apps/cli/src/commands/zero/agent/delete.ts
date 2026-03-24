import { Command } from "commander";
import chalk from "chalk";
import { getZeroAgent, deleteZeroAgent } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a zero agent")
  .argument("<name>", "Agent name")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
      await getZeroAgent(name);

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }
        const confirmed = await promptConfirm(
          `Delete zero agent '${name}'?`,
          false,
        );
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteZeroAgent(name);
      console.log(chalk.green(`✓ Zero agent '${name}' deleted`));
    }),
  );
