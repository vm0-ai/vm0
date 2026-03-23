import { Command } from "commander";
import chalk from "chalk";
import { deleteZeroOrgVariable } from "../../../../lib/api";
import {
  isInteractive,
  promptConfirm,
} from "../../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../../lib/command";

export const removeCommand = new Command()
  .name("remove")
  .description("Delete an org-level variable (admin only)")
  .argument("<name>", "Variable name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }

        const confirmed = await promptConfirm(
          `Are you sure you want to delete org variable "${name}"?`,
          false,
        );

        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteZeroOrgVariable(name);
      console.log(chalk.green(`✓ Org variable "${name}" deleted`));
    }),
  );
