import { Command } from "commander";
import chalk from "chalk";
import { getCredential, deleteCredential } from "../../lib/api";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a credential")
  .argument("<name>", "Credential name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name: string, options: { yes?: boolean }) => {
    try {
      // Verify credential exists first
      try {
        await getCredential(name);
      } catch {
        console.error(chalk.red(`✗ Credential "${name}" not found`));
        process.exit(1);
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
          `Are you sure you want to delete credential "${name}"?`,
          false,
        );

        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteCredential(name);
      console.log(chalk.green(`✓ Credential "${name}" deleted`));
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
