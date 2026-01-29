import { Command } from "commander";
import chalk from "chalk";
import { cancelRun } from "../../lib/api";

export const killCommand = new Command()
  .name("kill")
  .description("Kill (cancel) a pending or running run")
  .argument("<run-id>", "Run ID to kill")
  .action(async (runId: string) => {
    try {
      await cancelRun(runId);
      console.log(chalk.green(`✓ Run ${runId} cancelled`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to kill run"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else if (
          error.message.includes("not found") ||
          error.message.includes("No such run")
        ) {
          console.error(chalk.dim(`  Run not found: ${runId}`));
        } else if (error.message.includes("cannot be cancelled")) {
          console.error(chalk.dim(`  ${error.message}`));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
