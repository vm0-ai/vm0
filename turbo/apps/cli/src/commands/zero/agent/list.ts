import { Command } from "commander";
import chalk from "chalk";
import { listZeroAgents } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all zero agents")
  .action(
    withErrorHandler(async () => {
      const agents = await listZeroAgents();

      if (agents.length === 0) {
        console.log(chalk.dim("No zero agents found"));
        console.log(
          chalk.dim(
            '  Create one with: vm0 zero agent create --connectors github --display-name "My Agent"',
          ),
        );
        return;
      }

      const nameWidth = Math.max(4, ...agents.map((a) => a.name.length));
      const displayWidth = Math.max(
        12,
        ...agents.map((a) => (a.displayName ?? "").length),
      );

      const header = [
        "NAME".padEnd(nameWidth),
        "DISPLAY NAME".padEnd(displayWidth),
        "CONNECTORS",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const agent of agents) {
        const row = [
          agent.name.padEnd(nameWidth),
          (agent.displayName ?? "-").padEnd(displayWidth),
          agent.connectors.join(", ") || "-",
        ].join("  ");
        console.log(row);
      }
    }),
  );
