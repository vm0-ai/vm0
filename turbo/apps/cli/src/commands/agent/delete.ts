import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, deleteCompose } from "../../lib/api";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete an agent")
  .argument("<name>", "Agent name to delete")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
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
      try {
        await deleteCompose(compose.id);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("currently running")
        ) {
          throw new Error("Cannot delete agent: agent is currently running", {
            cause: new Error("Run: vm0 run list"),
          });
        }
        throw error;
      }
      console.log(chalk.green(`✓ Agent '${name}' deleted`));
    }),
  );
