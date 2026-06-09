import { Command } from "commander";
import chalk from "chalk";
import {
  disableZeroAutomation,
  resolveZeroAutomationByAgent,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const disableCommand = new Command()
  .name("disable")
  .description("Disable a zero automation")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <automation-name>",
    "Automation name (required when agent has multiple automations)",
  )
  .addHelpText(
    "after",
    `
Examples:
  zero automation disable <agent-id>
  zero automation disable <agent-id> -n my-automation`,
  )
  .action(
    withErrorHandler(async (agentName: string, options: { name?: string }) => {
      const resolved = await resolveZeroAutomationByAgent(
        agentName,
        options.name,
      );

      await disableZeroAutomation({
        name: resolved.name,
        agentId: resolved.agentId,
      });

      console.log(chalk.green(`✓ Automation "${resolved.name}" disabled`));
    }),
  );
