import { Command } from "commander";
import chalk from "chalk";
import { runAutomation } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const runCommand = new Command()
  .name("run")
  .description("Manually fire an automation (runs its instruction once)")
  .argument("<automation>", "Automation ID or name")
  .addHelpText(
    "after",
    `
Examples:
  zero automation run alerts`,
  )
  .action(
    withErrorHandler(async (ref: string) => {
      const { runId } = await runAutomation(ref);

      console.log(chalk.green(`✓ Automation "${ref}" fired`));
      console.log(chalk.dim(`  Run ID: ${runId}`));
    }),
  );
