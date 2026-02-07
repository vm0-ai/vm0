import { Command } from "commander";
import chalk from "chalk";
import { CONNECTOR_TYPES, connectorTypeSchema } from "@vm0/core";
import { deleteConnector } from "../../lib/api";

export const disconnectCommand = new Command()
  .name("disconnect")
  .description("Disconnect a third-party service")
  .argument("<type>", "Connector type to disconnect (e.g., github)")
  .action(async (type: string) => {
    try {
      const parseResult = connectorTypeSchema.safeParse(type);
      if (!parseResult.success) {
        console.error(chalk.red(`✗ Unknown connector type: ${type}`));
        console.log();
        console.log("Available connectors:");
        for (const [t, config] of Object.entries(CONNECTOR_TYPES)) {
          console.log(`  ${chalk.cyan(t)} - ${config.label}`);
        }
        process.exit(1);
      }

      await deleteConnector(parseResult.data);
      console.log(chalk.green(`✓ Disconnected ${type}`));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("not found")) {
          console.error(chalk.red(`✗ Connector "${type}" is not connected`));
        } else if (error.message.includes("Not authenticated")) {
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
