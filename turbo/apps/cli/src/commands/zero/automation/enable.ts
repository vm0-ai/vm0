import { Command } from "commander";
import chalk from "chalk";
import { enableAutomationV2 } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const enableCommand = new Command()
  .name("enable")
  .description("Enable an automation (all of its triggers resume)")
  .argument("<automation>", "Automation ID or name")
  .addHelpText(
    "after",
    `
Examples:
  zero automation enable alerts

Notes:
  - To enable a single trigger instead: zero automation trigger enable <trigger-id>`,
  )
  .action(
    withErrorHandler(async (ref: string) => {
      const automation = await enableAutomationV2(ref);

      console.log(chalk.green(`✓ Automation "${automation.name}" enabled`));
    }),
  );
