import { Command } from "commander";
import chalk from "chalk";
import { getVariable, deleteVariable } from "../../lib/api";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a variable")
  .argument("<name>", "Variable name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name: string, options: { yes?: boolean }) => {
    try {
      // Verify variable exists first
      try {
        await getVariable(name);
      } catch (error) {
        // Only show "not found" if it's actually a not found error
        // Otherwise, re-throw to let the outer catch handle it properly
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
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
