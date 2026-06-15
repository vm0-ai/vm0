import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConfiguredConnectorAuthMethodIds,
  getConnectorAuthMethod,
} from "@vm0/connectors/connector-utils";
import { connectZeroConnectorManualGrant } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

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
        "Example: zero connector connect zendesk --value ZENDESK_API_TOKEN=token",
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

function parseConnectorType(type: string): ConnectorType {
  const parsed = connectorTypeSchema.safeParse(type);
  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(`Unknown connector type: ${type}`, {
    cause: new Error(`Available connectors: ${CONNECTOR_TYPE_KEYS.join(", ")}`),
  });
}

function parseConfiguredAuthMethod(
  type: ConnectorType,
  rawAuthMethod: string,
): ConnectorAuthMethodId {
  const configuredAuthMethodIds = getConfiguredConnectorAuthMethodIds(type);
  const authMethod = configuredAuthMethodIds.find((method) => {
    return method === rawAuthMethod;
  });
  if (authMethod) {
    return authMethod;
  }

  throw new Error(
    `${type} connector does not have ${rawAuthMethod} auth method`,
    {
      cause: new Error(
        `Available auth methods: ${configuredAuthMethodIds.join(", ")}`,
      ),
    },
  );
}

function getManualGrantAuthMethods(
  type: ConnectorType,
): ConnectorAuthMethodId[] {
  return getConfiguredConnectorAuthMethodIds(type).filter((authMethod) => {
    return getConnectorAuthMethod(type, authMethod)?.grant.kind === "manual";
  });
}

function parseManualGrantAuthMethod(
  type: ConnectorType,
  rawAuthMethod: string | undefined,
): ConnectorAuthMethodId {
  if (rawAuthMethod) {
    const authMethod = parseConfiguredAuthMethod(type, rawAuthMethod);
    if (getConnectorAuthMethod(type, authMethod)?.grant.kind === "manual") {
      return authMethod;
    }

    throw new Error(
      `${type} ${authMethod} auth method does not use a manual grant`,
    );
  }

  const authMethods = getManualGrantAuthMethods(type);
  const authMethod = authMethods[0];
  if (authMethods.length === 1 && authMethod) {
    return authMethod;
  }

  if (authMethods.length === 0) {
    throw new Error(`${type} connector does not use a manual grant`);
  }

  throw new Error(`${type} connector has multiple manual grant auth methods`, {
    cause: new Error(`Pass --auth-method ${authMethods.join("|")}`),
  });
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
      const connectorType = parseConnectorType(type);
      const authMethod = parseManualGrantAuthMethod(
        connectorType,
        options.authMethod,
      );
      const connector = await connectZeroConnectorManualGrant(
        connectorType,
        authMethod,
        parseConnectorValues(options.value),
      );

      if (options.json) {
        console.log(JSON.stringify(connector, null, 2));
        return;
      }

      console.log(
        chalk.green(`✓ ${CONNECTOR_TYPES[connectorType].label} connected`),
      );
      console.log(chalk.dim(`  Type: ${connector.type}`));
      console.log(chalk.dim(`  Auth Method: ${connector.authMethod}`));
      console.log(chalk.dim(`  Run: zero connector status ${connector.type}`));
    }),
  );
