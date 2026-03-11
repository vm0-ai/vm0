import { Command } from "commander";
import chalk from "chalk";
import { getVariable, deleteVariable } from "../../lib/api";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a variable")
  .argument("<name>", "Variable name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
      // Verify variable exists first
      try {
        await getVariable(name);
      } catch (error) {
        // Only show "not found" if it's actually a not found error
        // Otherwise, re-throw to let withErrorHandler handle it properly
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("not found")
        ) {
          console.error(chalk.red(`✗ Variable "${name}" not found`));
          process.exit(1);
        }
        throw error;
      }

      // Confirm deletion unless --yes is passed
      if (!options.yes) {
        if (!isInteractive()) {
          console.error(
            chalk.red("✗ --yes flag is required in non-interactive mode"),
          );
          process.exit(1);
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

      await deleteVariable(name);
      console.log(chalk.green(`✓ Variable "${name}" deleted`));
    }),
  );
