import { Command } from "commander";
import chalk from "chalk";
import { deleteAutomation } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete an automation (its triggers are removed too)")
  .argument("<automation>", "Automation ID or name")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Examples:
  zero automation delete alerts
  zero automation delete alerts -y

Notes:
  - Use -y to skip confirmation in non-interactive mode`,
  )
  .action(
    withErrorHandler(async (ref: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }
        const confirmed = await promptConfirm(
          `Delete automation ${chalk.cyan(ref)} and all of its triggers?`,
          false,
        );
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteAutomation(ref);

      console.log(chalk.green(`✓ Automation "${ref}" deleted`));
    }),
  );
