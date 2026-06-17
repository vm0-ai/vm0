import { Command } from "commander";
import chalk from "chalk";
import { listWorkflows } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List visible workflows in the organization")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow list`,
  )
  .action(
    withErrorHandler(async () => {
      const workflows = await listWorkflows();

      if (workflows.length === 0) {
        console.log(chalk.dim("No workflows found"));
        console.log(
          chalk.dim(
            "  Create one with: zero workflow create <name> --dir <path>",
          ),
        );
        return;
      }

      const nameWidth = Math.max(
        4,
        ...workflows.map((s) => {
          return s.name.length;
        }),
      );
      const displayWidth = Math.max(
        12,
        ...workflows.map((s) => {
          return (s.displayName ?? "").length;
        }),
      );

      const header = [
        "NAME".padEnd(nameWidth),
        "VISIBILITY".padEnd(10),
        "AGENTS".padEnd(6),
        "DISPLAY NAME".padEnd(displayWidth),
        "DESCRIPTION",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const workflow of workflows) {
        const row = [
          workflow.name.padEnd(nameWidth),
          workflow.visibility.padEnd(10),
          String(workflow.attachedAgentCount).padEnd(6),
          (workflow.displayName ?? "-").padEnd(displayWidth),
          workflow.description ?? "-",
        ].join("  ");
        console.log(row);
      }
    }),
  );
