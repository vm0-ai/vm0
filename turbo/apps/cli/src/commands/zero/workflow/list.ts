import { Command } from "commander";
import chalk from "chalk";
import { listWorkflows } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List visible workflows, optionally scoped to one agent")
  .option("--agent <id>", "Only list workflows hosted by this agent")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow list
  zero workflow list --agent <agent-id>`,
  )
  .action(
    withErrorHandler(async (options: { agent?: string }) => {
      const workflows = await listWorkflows({ agentId: options.agent });

      if (workflows.length === 0) {
        console.log(chalk.dim("No workflows found"));
        console.log(
          chalk.dim(
            "  Create one with: zero workflow create <name> --agent <agent-id> --instruction <text>",
          ),
        );
        return;
      }

      const idWidth = Math.max(
        2,
        ...workflows.map((s) => {
          return s.id.length;
        }),
      );
      const nameWidth = Math.max(
        4,
        ...workflows.map((s) => {
          return s.name.length;
        }),
      );
      const agentWidth = Math.max(
        5,
        ...workflows.map((s) => {
          return (s.agentName ?? s.agentId).length;
        }),
      );

      const header = [
        "ID".padEnd(idWidth),
        "NAME".padEnd(nameWidth),
        "VISIBILITY".padEnd(10),
        "AGENT".padEnd(agentWidth),
        "DESCRIPTION",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const workflow of workflows) {
        const row = [
          workflow.id.padEnd(idWidth),
          workflow.name.padEnd(nameWidth),
          workflow.visibility.padEnd(10),
          (workflow.agentName ?? workflow.agentId).padEnd(agentWidth),
          workflow.description ?? "-",
        ].join("  ");
        console.log(row);
      }
    }),
  );
