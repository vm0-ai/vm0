import { Command } from "commander";
import chalk from "chalk";
import { CONNECTOR_TYPES, connectorTypeSchema } from "@vm0/core";
import { getConnector } from "../../lib/api";
import { formatDateTime } from "../../lib/domain/schedule-utils";

const LABEL_WIDTH = 16;

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a connector")
  .argument("<type>", "Connector type (e.g., github)")
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

      const connector = await getConnector(parseResult.data);

      console.log(`Connector: ${chalk.cyan(type)}`);
      console.log();

      if (connector) {
        console.log(
          `${"Status:".padEnd(LABEL_WIDTH)}${chalk.green("connected")}`,
        );
        console.log(
          `${"Account:".padEnd(LABEL_WIDTH)}@${connector.externalUsername}`,
        );
        console.log(
          `${"Auth Method:".padEnd(LABEL_WIDTH)}${connector.authMethod}`,
        );

        if (connector.oauthScopes && connector.oauthScopes.length > 0) {
          console.log(
            `${"OAuth Scopes:".padEnd(LABEL_WIDTH)}${connector.oauthScopes.join(", ")}`,
          );
        }

        console.log(
          `${"Connected:".padEnd(LABEL_WIDTH)}${formatDateTime(connector.createdAt)}`,
        );

        if (connector.updatedAt !== connector.createdAt) {
          console.log(
            `${"Last Updated:".padEnd(LABEL_WIDTH)}${formatDateTime(connector.updatedAt)}`,
          );
        }

        console.log();
        console.log(chalk.dim("To disconnect:"));
        console.log(chalk.dim(`  vm0 connector disconnect ${type}`));
      } else {
        console.log(
          `${"Status:".padEnd(LABEL_WIDTH)}${chalk.dim("not connected")}`,
        );
        console.log();
        console.log(chalk.dim("To connect:"));
        console.log(chalk.dim(`  vm0 connector connect ${type}`));
      }
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
