import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPES,
  hasRequiredScopes,
  isFeatureEnabled,
  type ConnectorType,
} from "@vm0/core";
import { listZeroConnectors } from "../../../lib/api";
import { getActiveOrg } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all connectors and their status")
  .action(
    withErrorHandler(async () => {
      const result = await listZeroConnectors();
      const connectedMap = new Map(
        result.connectors.map((c) => {
          return [c.type, c];
        }),
      );
      const orgId = await getActiveOrg();

      const allTypesRaw = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
      const allTypes: ConnectorType[] = [];
      for (const type of allTypesRaw) {
        const flag = CONNECTOR_TYPES[type].featureFlag;
        const hasApiToken = "api-token" in CONNECTOR_TYPES[type].authMethods;
        if (flag && !isFeatureEnabled(flag, { orgId }) && !hasApiToken) {
          continue;
        }
        allTypes.push(type);
      }

      // Calculate column widths
      const typeWidth = Math.max(
        4,
        ...allTypes.map((t) => {
          return t.length;
        }),
      );
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
        const scopeMismatch =
          connector !== undefined &&
          connector.authMethod === "oauth" &&
          !hasRequiredScopes(type, connector.oauthScopes);
        const status = connector
          ? connector.needsReconnect
            ? chalk.yellow("!".padEnd(statusWidth))
            : scopeMismatch
              ? chalk.yellow("!".padEnd(statusWidth))
              : chalk.green("✓".padEnd(statusWidth))
          : chalk.dim("-".padEnd(statusWidth));
        const account = connector?.needsReconnect
          ? chalk.yellow("(reconnect needed)")
          : scopeMismatch
            ? chalk.yellow("(permissions update available)")
            : connector?.externalUsername
              ? `@${connector.externalUsername}`
              : chalk.dim("-");

        const row = [type.padEnd(typeWidth), status, account].join("  ");
        console.log(row);
      }
    }),
  );
