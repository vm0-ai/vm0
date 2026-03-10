import { Command } from "commander";
import chalk from "chalk";
import { cancelRun } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const killCommand = new Command()
  .name("kill")
  .description("Kill (cancel) a pending or running run")
  .argument("<run-id>", "Run ID to kill")
  .action(
    withErrorHandler(async (runId: string) => {
      await cancelRun(runId);
      console.log(chalk.green(`✓ Run ${runId} cancelled`));
    }),
  );
