import { Command } from "commander";
import chalk from "chalk";
import {
  disableZeroSchedule,
  resolveZeroScheduleByAgent,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const disableCommand = new Command()
  .name("disable")
  .description("Disable a zero schedule")
  .argument("<agent-name>", "Agent name")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .action(
    withErrorHandler(async (agentName: string, options: { name?: string }) => {
      const resolved = await resolveZeroScheduleByAgent(
        agentName,
        options.name,
      );

      await disableZeroSchedule({
        name: resolved.name,
        zeroAgentId: resolved.zeroAgentId,
      });

      console.log(
        chalk.green(`✓ Disabled schedule for agent ${chalk.cyan(agentName)}`),
      );
    }),
  );
