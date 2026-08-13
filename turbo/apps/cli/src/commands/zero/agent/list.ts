import { Command } from "commander";
import chalk from "chalk";
import { listZeroAgents } from "../../../lib/api/domains/zero-agents";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all agents")
  .addHelpText(
    "after",
    `
Examples:
  okou agent list

Notes:
  - Use this to discover teammate agent IDs`,
  )
  .action(
    withErrorHandler(async () => {
      const agents = await listZeroAgents();

      if (agents.length === 0) {
        console.log(chalk.dim("No agents found"));
        console.log(
          chalk.dim(
            '  Create one with: okou agent create --display-name "My Agent"',
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
      const visibilityWidth = "VISIBILITY".length;

      const header = [
        "AGENT ID".padEnd(idWidth),
        "DISPLAY NAME".padEnd(displayWidth),
        "VISIBILITY".padEnd(visibilityWidth),
      ].join("  ");
      console.log(chalk.dim(header));

      for (const agent of agents) {
        const row = [
          agent.agentId.padEnd(idWidth),
          (agent.displayName ?? "-").padEnd(displayWidth),
          // Commit-addressed CLI/backend responses may omit visibility. Remove
          // after #26761 verifies producers and queued/active contexts have drained.
          (agent.visibility ?? "-").padEnd(visibilityWidth),
        ].join("  ");
        console.log(row);
      }
    }),
  );
