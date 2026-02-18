import { Command } from "commander";
import chalk from "chalk";
import { CONNECTOR_TYPES, connectorTypeSchema } from "@vm0/core";
import { deleteConnector } from "../../lib/api";
import { stopComputerServices } from "./lib/computer/stop-services";
import { readPid } from "./lib/computer/pid-manager";

export const disconnectCommand = new Command()
  .name("disconnect")
  .description("Disconnect a third-party service")
  .argument("<type>", "Connector type to disconnect (e.g., github)")
  .action(async (type: string) => {
    try {
      const parseResult = connectorTypeSchema.safeParse(type);
      if (!parseResult.success) {
        console.error(chalk.red(`✗ Unknown connector type: ${type}`));
        console.error();
        console.error("Available connectors:");
        for (const [t, config] of Object.entries(CONNECTOR_TYPES)) {
          console.error(`  ${chalk.cyan(t)} - ${config.label}`);
        }
        process.exit(1);
      }

      const connectorType = parseResult.data;

      // Special flow for computer connector
      if (connectorType === "computer") {
        const connectPid = await readPid("connector-connect");
        if (connectPid) {
          try {
            // Signal the running connect process to clean up and exit
            process.kill(connectPid, "SIGTERM");
            console.log(chalk.green("✓ Sent disconnect signal to connector"));
            return;
          } catch (err) {
            if (
              !(
                err &&
                typeof err === "object" &&
                "code" in err &&
                err.code === "ESRCH"
              )
            ) {
              throw err;
            }
            // Connect process is gone — fall through to direct cleanup
          }
        }
        // No connect process running — clean up directly
        await stopComputerServices();
      }

      await deleteConnector(connectorType);
      console.log(chalk.green(`✓ Disconnected ${type}`));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("not found")) {
          console.error(chalk.red(`✗ Connector "${type}" is not connected`));
        } else if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
          if (error.cause instanceof Error) {
            console.error(chalk.dim(`  Cause: ${error.cause.message}`));
          }
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
