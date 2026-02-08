import { Command } from "commander";
import chalk from "chalk";
import { CONNECTOR_TYPES } from "@vm0/core";
import { listConnectors } from "../../lib/api";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all connectors and their status")
  .action(async () => {
    try {
      const result = await listConnectors();
      const connectedMap = new Map(result.connectors.map((c) => [c.type, c]));

      const allTypes = Object.keys(CONNECTOR_TYPES) as Array<
        keyof typeof CONNECTOR_TYPES
      >;

      // Calculate column widths
      const typeWidth = Math.max(4, ...allTypes.map((t) => t.length));
      const statusText = "STATUS";
      const statusWidth = statusText.length;

      // Print header
      const header = [
        "TYPE".padEnd(typeWidth),
        statusText.padEnd(statusWidth),
        "ACCOUNT",
      ].join("  ");
      console.log(chalk.dim(header));

      // Print rows
      for (const type of allTypes) {
        const connector = connectedMap.get(type);
        const status = connector
          ? chalk.green("✓".padEnd(statusWidth))
          : chalk.dim("-".padEnd(statusWidth));
        const account = connector?.externalUsername
          ? `@${connector.externalUsername}`
          : chalk.dim("-");

        const row = [type.padEnd(typeWidth), status, account].join("  ");
        console.log(row);
      }

      // Always show connect hint
      console.log();
      console.log(chalk.dim("To connect a service:"));
      console.log(chalk.dim("  vm0 connector connect <type>"));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
