import { Command } from "commander";
import chalk from "chalk";
import {
  enableZeroAutomation,
  resolveZeroAutomationByAgent,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const enableCommand = new Command()
  .name("enable")
  .description("Enable a zero automation")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <automation-name>",
    "Automation name (required when agent has multiple automations)",
  )
  .addHelpText(
    "after",
    `
Examples:
  zero automation enable <agent-id>
  zero automation enable <agent-id> -n my-automation`,
  )
  .action(
    withErrorHandler(async (agentName: string, options: { name?: string }) => {
      const resolved = await resolveZeroAutomationByAgent(
        agentName,
        options.name,
      );

      await enableZeroAutomation({
        name: resolved.name,
        agentId: resolved.agentId,
      });

      console.log(chalk.green(`✓ Automation "${resolved.name}" enabled`));
    }),
  );
