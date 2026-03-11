import { Command } from "commander";
import chalk from "chalk";
import { CONNECTOR_TYPES, connectorTypeSchema } from "@vm0/core";
import { deleteConnector } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const disconnectCommand = new Command()
  .name("disconnect")
  .description("Disconnect a third-party service")
  .argument("<type>", "Connector type to disconnect (e.g., github)")
  .action(
    withErrorHandler(async (type: string) => {
      const parseResult = connectorTypeSchema.safeParse(type);
      if (!parseResult.success) {
        const available = Object.keys(CONNECTOR_TYPES).join(", ");
        throw new Error(`Unknown connector type: ${type}`, {
          cause: new Error(`Available connectors: ${available}`),
        });
      }

      const connectorType = parseResult.data;
      await deleteConnector(connectorType);
      console.log(chalk.green(`✓ Disconnected ${type}`));
    }),
  );
