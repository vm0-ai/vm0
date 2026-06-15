import { Command } from "commander";
import chalk from "chalk";
import { disableAutomation } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const disableCommand = new Command()
  .name("disable")
  .description("Disable an automation (suspends all of its triggers)")
  .argument("<automation>", "Automation ID or name")
  .addHelpText(
    "after",
    `
Examples:
  zero automation disable alerts

Notes:
  - To disable a single trigger instead: zero automation trigger disable <trigger-id>`,
  )
  .action(
    withErrorHandler(async (ref: string) => {
      const automation = await disableAutomation(ref);

      console.log(chalk.green(`✓ Automation "${automation.name}" disabled`));
    }),
  );
