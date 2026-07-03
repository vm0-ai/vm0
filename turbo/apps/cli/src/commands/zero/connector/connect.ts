import { Command } from "commander";
import chalk from "chalk";
import {
  connectZeroConnectorManualGrant,
  listZeroConnectorCatalogStatus,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import {
  availableConnectorRefs,
  findConnectorStatusItem,
  parseConnectorAuthMethodIdForAction,
  parseConnectorTypeForAction,
  resolveManualGrantAuthMethod,
} from "./public-catalog";

interface ConnectOptions {
  readonly authMethod?: string;
  readonly value?: readonly string[];
  readonly json?: boolean;
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseConnectorValues(rawValues: readonly string[] | undefined) {
  if (!rawValues || rawValues.length === 0) {
    throw new Error("At least one --value NAME=VALUE is required", {
      cause: new Error(
        "Example: zero connector connect zendesk --value apiToken=token",
      ),
    });
  }

  const values: Record<string, string> = {};
  for (const rawValue of rawValues) {
    const separatorIndex = rawValue.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error("Invalid --value format", {
        cause: new Error("Use --value NAME=VALUE"),
      });
    }

    const name = rawValue.slice(0, separatorIndex);
    if (!name.trim()) {
      throw new Error("Invalid --value format", {
        cause: new Error("Field name cannot be empty"),
      });
    }

    values[name] = rawValue.slice(separatorIndex + 1);
  }

  return values;
}

export const connectCommand = new Command()
  .name("connect")
  .description("Connect a connector with manual grant values")
  .argument("<type>", "Connector type (e.g., zendesk)")
  .option("--auth-method <method>", "Connector auth method to use")
  .option(
    "--value <name=value>",
    "Connector field value; repeat for multiple fields",
    collectValue,
    [],
  )
  .option("--json", "Print the connector response as JSON")
  .action(
    withErrorHandler(async (type: string, options: ConnectOptions) => {
      const values = parseConnectorValues(options.value);
      const catalog = await listZeroConnectorCatalogStatus();
      const connectorMetadata = findConnectorStatusItem(
        catalog.connectors,
        type,
      );
      if (!connectorMetadata) {
        throw new Error(`Unknown or unavailable connector: ${type}`, {
          cause: new Error(
            `Available connectors: ${availableConnectorRefs(catalog.connectors)}`,
          ),
        });
      }

      const connectorType = parseConnectorTypeForAction(
        connectorMetadata.connectorRef,
      );
      const authMethod = resolveManualGrantAuthMethod(
        connectorMetadata,
        options.authMethod,
      );
      const connector = await connectZeroConnectorManualGrant(
        connectorType,
        parseConnectorAuthMethodIdForAction(authMethod.id),
        values,
      );

      if (options.json) {
        console.log(JSON.stringify(connector, null, 2));
        return;
      }

      console.log(chalk.green(`✓ ${connectorMetadata.label} connected`));
      console.log(chalk.dim(`  Type: ${connector.type}`));
      console.log(chalk.dim(`  Auth Method: ${connector.authMethod}`));
      console.log(chalk.dim(`  Run: zero connector status ${connector.type}`));
    }),
  );
