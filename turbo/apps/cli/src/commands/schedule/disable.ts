import { Command } from "commander";
import chalk from "chalk";
import { disableSchedule } from "../../lib/api";
import { resolveScheduleByAgent } from "../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../lib/command";

export const disableCommand = new Command()
  .name("disable")
  .description("Disable a schedule")
  .argument("<agent-name>", "Agent name")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .action(
    withErrorHandler(async (agentName: string, options: { name?: string }) => {
      // Resolve schedule by agent name
      const resolved = await resolveScheduleByAgent(agentName, options.name);

      // Call API
      await disableSchedule({
        name: resolved.name,
        composeId: resolved.composeId,
        scopeId: resolved.scopeId,
      });

      console.log(
        chalk.green(`✓ Disabled schedule for agent ${chalk.cyan(agentName)}`),
      );
    }),
  );
