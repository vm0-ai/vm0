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
        throw new Error(`Agent '${name}' not found`, {
          cause: new Error("Run: vm0 agent list"),
        });
      }

      // 2. Confirm deletion
      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
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
