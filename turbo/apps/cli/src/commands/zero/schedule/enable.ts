import { Command } from "commander";
import chalk from "chalk";
import {
  enableZeroSchedule,
  resolveZeroScheduleByAgent,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const enableCommand = new Command()
  .name("enable")
  .description("Enable a zero schedule")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .action(
    withErrorHandler(async (agentId: string, options: { name?: string }) => {
      const resolved = await resolveZeroScheduleByAgent(agentId, options.name);

      await enableZeroSchedule({
        name: resolved.name,
        agentId: resolved.agentId,
      });

      console.log(
        chalk.green(`✓ Enabled schedule for agent ${chalk.cyan(agentId)}`),
      );
    }),
  );
