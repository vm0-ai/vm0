import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, deleteCompose } from "../../lib/api";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete an agent")
  .argument("<name>", "Agent name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name: string, options: { yes?: boolean }) => {
    try {
      // 1. Resolve agent name to compose
      const compose = await getComposeByName(name);
      if (!compose) {
        console.error(chalk.red(`✗ Agent '${name}' not found`));
        console.error(chalk.dim("  Run: vm0 agent list"));
        process.exit(1);
      }

      // 2. Confirm deletion
      if (!options.yes) {
        if (!isInteractive()) {
          console.error(
            chalk.red("✗ --yes flag is required in non-interactive mode"),
          );
          process.exit(1);
        }
        const confirmed = await promptConfirm(`Delete agent '${name}'?`, false);
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      // 3. Call delete API
      await deleteCompose(compose.id);
      console.log(chalk.green(`✓ Agent '${name}' deleted`));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated"));
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else if (error.message.includes("currently running")) {
          console.error(
            chalk.red("✗ Cannot delete agent: agent is currently running"),
          );
          console.error(chalk.dim("  Run: vm0 run list"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
