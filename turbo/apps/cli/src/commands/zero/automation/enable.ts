import { Command } from "commander";
import chalk from "chalk";
import { enableAutomation } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const enableCommand = new Command()
  .name("enable")
  .description("Enable an automation")
  .argument("<automation>", "Automation ID or name")
  .addHelpText(
    "after",
    `
Examples:
  zero automation enable alerts`,
  )
  .action(
    withErrorHandler(async (ref: string) => {
      const automation = await enableAutomation(ref);

      console.log(chalk.green(`✓ Automation "${automation.name}" enabled`));
    }),
  );
