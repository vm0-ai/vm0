import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorType,
  connectorTypeSchema,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethodScopeDiff,
  hasRequiredConnectorAuthMethodScopes,
} from "@vm0/connectors/connector-utils";
import { getZeroConnector, searchZeroConnectors } from "../../../lib/api";
import { formatDateTime } from "../../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../../lib/command";
import { resolveAgentContext } from "./agent-context";
import { getPlatformOrigin } from "../doctor/platform-url";

const LABEL_WIDTH = 16;

type Connector = NonNullable<Awaited<ReturnType<typeof getZeroConnector>>>;
type AgentContext = NonNullable<
  Awaited<ReturnType<typeof resolveAgentContext>>
>;

function isConnectorType(type: string): type is ConnectorType {
  return type in CONNECTOR_TYPES;
}

async function availableConnectorTypes(): Promise<Set<ConnectorType>> {
  const catalog = await searchZeroConnectors();
  return new Set(
    catalog.connectors
      .map((connector) => {
        return connector.id;
      })
      .filter(isConnectorType),
  );
}

function printConnectorDetails(
  type: ConnectorType,
  connector: Connector | null,
): void {
  if (connector) {
    console.log(
      `${"Status:".padEnd(LABEL_WIDTH)}${
        connector.connectionStatus === "reconnect-required"
          ? chalk.yellow("reconnect needed")
          : chalk.green("connected")
      }`,
    );
    console.log(
      `${"Account:".padEnd(LABEL_WIDTH)}@${connector.externalUsername}`,
    );
    console.log(`${"Auth Method:".padEnd(LABEL_WIDTH)}${connector.authMethod}`);

    if (connector.oauthScopes && connector.oauthScopes.length > 0) {
      console.log(
        `${"OAuth Scopes:".padEnd(LABEL_WIDTH)}${connector.oauthScopes.join(", ")}`,
      );
    }

    if (
      !hasRequiredConnectorAuthMethodScopes(
        type,
        connector.authMethod,
        connector.oauthScopes,
      )
    ) {
      const diff = getConnectorAuthMethodScopeDiff(
        type,
        connector.authMethod,
        connector.oauthScopes,
      );
      console.log(
        `${"Permissions:".padEnd(LABEL_WIDTH)}${chalk.yellow("update available")}`,
      );
      if (diff.addedScopes.length > 0) {
        console.log(
          `${"  Added:".padEnd(LABEL_WIDTH)}${diff.addedScopes.join(", ")}`,
        );
      }
      if (diff.removedScopes.length > 0) {
        console.log(
          `${"  Removed:".padEnd(LABEL_WIDTH)}${diff.removedScopes.join(", ")}`,
        );
      }
    }

    console.log(
      `${"Connected:".padEnd(LABEL_WIDTH)}${formatDateTime(connector.createdAt)}`,
    );

    if (connector.updatedAt !== connector.createdAt) {
      console.log(
        `${"Last Updated:".padEnd(LABEL_WIDTH)}${formatDateTime(connector.updatedAt)}`,
      );
    }
  } else {
    console.log(
      `${"Status:".padEnd(LABEL_WIDTH)}${chalk.dim("not connected")}`,
    );
  }
}

async function printAgentAction(
  type: ConnectorType,
  connector: Connector | null,
  agentCtx: AgentContext,
): Promise<void> {
  const authorized = agentCtx.authorizedTypes.has(type);
  const isConnected = connector !== null;
  const needsReconnect = connector?.connectionStatus === "reconnect-required";
  const agentLabel =
    agentCtx.displayName === agentCtx.agentId
      ? agentCtx.agentId
      : `${agentCtx.displayName} (${agentCtx.agentId})`;

  console.log();
  if (needsReconnect) {
    const origin = await getPlatformOrigin();
    const url = `${origin}/connectors`;
    console.log(
      `The ${type} connector is connected but needs to be reconnected before agent ${agentLabel} can use it.`,
    );
    console.log(`Reconnect it at: [Reconnect ${type}](${url})`);
  } else if (authorized && !isConnected) {
    const origin = await getPlatformOrigin();
    const url = `${origin}/connectors/${type}/connect?agentId=${agentCtx.agentId}`;
    console.log(
      `The ${type} connector is authorized for agent ${agentLabel}, but it is not connected.`,
    );
    console.log(`Connect it at: [Connect ${type}](${url})`);
  } else if (authorized) {
    console.log(`The ${type} connector is authorized for agent ${agentLabel}.`);
  } else if (!isConnected) {
    const origin = await getPlatformOrigin();
    const url = `${origin}/connectors/${type}/connect?agentId=${agentCtx.agentId}`;
    console.log(
      `The ${type} connector is not connected. Once connected, it will be authorized for agent ${agentLabel}.`,
    );
    console.log(`Connect and authorize it at: [Connect ${type}](${url})`);
  } else {
    const origin = await getPlatformOrigin();
    const url = `${origin}/connectors/${type}/authorize?agentId=${agentCtx.agentId}`;
    console.log(
      `The ${type} connector is not authorized for agent ${agentLabel}.`,
    );
    console.log(`Authorize it at: [Authorize ${type}](${url})`);
  }
}

async function printStandaloneAction(
  type: ConnectorType,
  connector: Connector | null,
): Promise<void> {
  if (connector?.connectionStatus === "connected") return;

  const origin = await getPlatformOrigin();
  console.log();
  if (connector?.connectionStatus === "reconnect-required") {
    const url = `${origin}/connectors`;
    console.log(
      `The ${type} connector is connected but needs to be reconnected.`,
    );
    console.log(`Reconnect it at: [Reconnect ${type}](${url})`);
  } else {
    const url = `${origin}/connectors/${type}/connect`;
    console.log(`Connect it at: [Connect ${type}](${url})`);
  }
}

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a connector")
  .argument("<type>", "Connector type (e.g., github)")
  .option("--agent <id>", "Show authorization state for the given agent")
  .action(
    withErrorHandler(async (type: string, options: { agent?: string }) => {
      const parseResult = connectorTypeSchema.safeParse(type);
      if (!parseResult.success) {
        const available = CONNECTOR_TYPE_KEYS.join(", ");
        throw new Error(`Unknown connector type: ${type}`, {
          cause: new Error(`Available connectors: ${available}`),
        });
      }

      const [connector, availableTypes, agentCtx] = await Promise.all([
        getZeroConnector(parseResult.data),
        availableConnectorTypes(),
        resolveAgentContext(options.agent),
      ]);
      const available = availableTypes.has(parseResult.data);

      console.log(`Connector: ${chalk.cyan(type)}`);
      console.log();

      printConnectorDetails(parseResult.data, connector);
      if (!available) {
        console.log();
        console.log(`The ${type} connector is not available for this account.`);
        return;
      }

      if (agentCtx) {
        await printAgentAction(parseResult.data, connector, agentCtx);
      } else {
        await printStandaloneAction(parseResult.data, connector);
      }
    }),
  );
