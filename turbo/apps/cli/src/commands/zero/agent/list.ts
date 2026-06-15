import { Command } from "commander";
import chalk from "chalk";
import { listZeroAgents } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all zero agents")
  .addHelpText(
    "after",
    `
Examples:
  zero agent list

Notes:
  - Use this to discover teammate agent IDs`,
  )
  .action(
    withErrorHandler(async () => {
      const agents = await listZeroAgents();

      if (agents.length === 0) {
        console.log(chalk.dim("No zero agents found"));
        console.log(
          chalk.dim(
            '  Create one with: zero agent create --display-name "My Agent"',
          ),
        );
        return;
      }

      const idWidth = Math.max(
        8,
        ...agents.map((a) => {
          return a.agentId.length;
        }),
      );
      const displayWidth = Math.max(
        12,
        ...agents.map((a) => {
          return (a.displayName ?? "").length;
        }),
      );

      const header = [
        "AGENT ID".padEnd(idWidth),
        "DISPLAY NAME".padEnd(displayWidth),
      ].join("  ");
      console.log(chalk.dim(header));

      for (const agent of agents) {
        const row = [
          agent.agentId.padEnd(idWidth),
          (agent.displayName ?? "-").padEnd(displayWidth),
        ].join("  ");
        console.log(row);
      }
    }),
  );
