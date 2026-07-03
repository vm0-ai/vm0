import { Command } from "commander";
import chalk from "chalk";
import { deleteZeroVariable } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a variable")
  .argument("<name>", "Variable name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }

        const confirmed = await promptConfirm(
          `Are you sure you want to delete variable "${name}"?`,
          false,
        );

        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteZeroVariable(name);
      console.log(chalk.green(`✓ Variable "${name}" deleted`));
    }),
  );
