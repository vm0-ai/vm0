import { Command } from "commander";
import chalk from "chalk";
import { getSecret, deleteSecret } from "../../lib/api";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a secret")
  .argument("<name>", "Secret name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
      // Verify secret exists first
      try {
        await getSecret(name);
      } catch (error) {
        // Only show "not found" if it's actually a not found error
        // Otherwise, re-throw to let withErrorHandler handle it properly
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("not found")
        ) {
          console.error(chalk.red(`✗ Secret "${name}" not found`));
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
          `Are you sure you want to delete secret "${name}"?`,
          false,
        );

        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteSecret(name);
      console.log(chalk.green(`✓ Secret "${name}" deleted`));
    }),
  );
