import { Command } from "commander";
import chalk from "chalk";
import { listConnectorCatalogStatus } from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveAgentContext } from "./agent-context";
import { getPlatformOrigin } from "../doctor/platform-url";
import {
  availableConnectorSlugs,
  findConnectorStatusItem,
  type PublicConnectorStatus,
} from "./public-catalog";
import {
  connectorActionUrl,
  printCallbackActionUrlExample,
} from "./action-url";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "./run-account-context";

const LABEL_WIDTH = 16;

type AgentContext = NonNullable<
  Awaited<ReturnType<typeof resolveAgentContext>>
>;

function printConnectorDetails(connector: PublicConnectorStatus): void {
  if (connector.connectionStatus === "not-connected") {
    console.log(
      `${"Status:".padEnd(LABEL_WIDTH)}${chalk.dim("not connected")}`,
    );
    return;
  }

  console.log(
    `${"Status:".padEnd(LABEL_WIDTH)}${
      connector.connectionStatus === "reconnect-required"
        ? chalk.yellow("reconnect needed")
        : chalk.green("connected")
    }`,
  );
  if (connector.connection?.externalUsername) {
    console.log(
      `${"Account:".padEnd(LABEL_WIDTH)}@${connector.connection.externalUsername}`,
    );
  } else if (connector.connection?.externalEmail) {
    console.log(
      `${"Account:".padEnd(LABEL_WIDTH)}${connector.connection.externalEmail}`,
    );
  }
  if (connector.connection?.authMethod) {
    console.log(
      `${"Auth Method:".padEnd(LABEL_WIDTH)}${connector.connection.authMethod}`,
    );
  }
  if (connector.scopeMismatch) {
    console.log(
      `${"Permissions:".padEnd(LABEL_WIDTH)}${chalk.yellow("update available")}`,
    );
  }
  if (connector.tokenExpiresAt) {
    console.log(
      `${"Token Expires:".padEnd(LABEL_WIDTH)}${connector.tokenExpiresAt}`,
    );
  }
}

async function printAgentAction(
  connector: PublicConnectorStatus,
  agentCtx: AgentContext,
): Promise<void> {
  const connectorSlug = connector.slug;
  const authorized = agentCtx.authorizedConnectorSlugs.has(connectorSlug);
  const isConnected = connector.connected;
  const needsReconnect = connector.connectionStatus === "reconnect-required";
  const agentLabel =
    agentCtx.displayName === agentCtx.agentId
      ? agentCtx.agentId
      : `${agentCtx.displayName} (${agentCtx.agentId})`;

  console.log();
  if (needsReconnect) {
    const origin = await getPlatformOrigin();
    const url = connectorActionUrl({
      origin,
      path: `/connectors/${connectorSlug}/connect`,
      agentId: agentCtx.agentId,
    });
    console.log(
      `The ${connectorSlug} connector is connected but needs to be reconnected before agent ${agentLabel} can use it.`,
    );
    console.log(`Reconnect it at: [Reconnect ${connectorSlug}](${url})`);
    printCallbackActionUrlExample(url, agentCtx.agentId);
  } else if (authorized && !isConnected) {
    const origin = await getPlatformOrigin();
    const url = connectorActionUrl({
      origin,
      path: `/connectors/${connectorSlug}/connect`,
      agentId: agentCtx.agentId,
    });
    console.log(
      `The ${connectorSlug} connector is authorized for agent ${agentLabel}, but it is not connected.`,
    );
    console.log(`Connect it at: [Connect ${connectorSlug}](${url})`);
    printCallbackActionUrlExample(url, agentCtx.agentId);
  } else if (authorized) {
    console.log(
      `The ${connectorSlug} connector is authorized for agent ${agentLabel}.`,
    );
  } else if (!isConnected) {
    const origin = await getPlatformOrigin();
    const url = connectorActionUrl({
      origin,
      path: `/connectors/${connectorSlug}/connect`,
      agentId: agentCtx.agentId,
    });
    console.log(
      `The ${connectorSlug} connector is not connected. Once connected, it will be authorized for agent ${agentLabel}.`,
    );
    console.log(
      `Connect and authorize it at: [Connect ${connectorSlug}](${url})`,
    );
    printCallbackActionUrlExample(url, agentCtx.agentId);
  } else {
    const origin = await getPlatformOrigin();
    const url = connectorActionUrl({
      origin,
      path: `/connectors/${connectorSlug}/authorize`,
      agentId: agentCtx.agentId,
    });
    console.log(
      `The ${connectorSlug} connector is not authorized for agent ${agentLabel}.`,
    );
    console.log(`Authorize it at: [Authorize ${connectorSlug}](${url})`);
    printCallbackActionUrlExample(url, agentCtx.agentId);
  }
}

async function printStandaloneAction(
  connector: PublicConnectorStatus,
): Promise<void> {
  const connectorSlug = connector.slug;
  if (
    connector.connectionStatus === "connected" ||
    connector.connectionStatus === "scope-mismatch"
  ) {
    return;
  }

  const origin = await getPlatformOrigin();
  console.log();
  if (connector.connectionStatus === "reconnect-required") {
    const url = `${origin}/connectors`;
    console.log(
      `The ${connectorSlug} connector is connected but needs to be reconnected.`,
    );
    console.log(`Reconnect it at: [Reconnect ${connectorSlug}](${url})`);
  } else {
    const url = `${origin}/connectors/${connectorSlug}/connect`;
    console.log(`Connect it at: [Connect ${connectorSlug}](${url})`);
  }
}

function printRunConnectorDetails(connector: RunConnectorAccountEntry): void {
  console.log(`Connector: ${chalk.cyan(connector.slug)}`);
  console.log();
  if (connector.account.state === "not-admitted") {
    console.log(
      `${"Account Used:".padEnd(LABEL_WIDTH)}${chalk.dim("unavailable for this run")}`,
    );
    console.log();
    console.log(
      "Reconnect or change the thread selection, then start a new run.",
    );
    return;
  }
  console.log(
    `${"Account Used:".padEnd(LABEL_WIDTH)}${
      connector.account.state === "available"
        ? connector.account.label
        : chalk.dim("metadata unavailable or deleted")
    }`,
  );
  console.log(
    `${"Connection ID:".padEnd(LABEL_WIDTH)}${connector.account.connectionId}`,
  );
  if (connector.account.state === "metadata-unavailable") {
    console.log(
      `${"Current Status:".padEnd(LABEL_WIDTH)}${chalk.dim("unavailable")}`,
    );
    return;
  }
  console.log(
    `${"Current Status:".padEnd(LABEL_WIDTH)}${connector.account.metadata.connectionStatus}`,
  );
  console.log(
    `${"Auth Method:".padEnd(LABEL_WIDTH)}${connector.account.metadata.authMethod}`,
  );
  if (connector.account.metadata.reconnectReason) {
    console.log(
      `${"Reconnect Reason:".padEnd(LABEL_WIDTH)}${connector.account.metadata.reconnectReason}`,
    );
  }
}

async function printRunConnectorStatus(
  connectorSlug: string,
  json: boolean,
): Promise<void> {
  const view = await resolveRunConnectorAccountView();
  if (view.state === "unavailable") {
    if (json) {
      console.log(
        JSON.stringify(
          {
            context: "run",
            state: "unavailable",
            reason: view.reason,
            connector: null,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(runConnectorAccountUnavailableMessage(view.reason));
    }
    return;
  }
  const connector = view.connectors.find((candidate) => {
    return candidate.slug === connectorSlug;
  });
  if (!connector) {
    throw new Error(
      `Connector is not available in this run: ${connectorSlug}`,
      {
        cause: new Error(
          `Available connectors: ${view.connectors
            .map((candidate) => {
              return candidate.slug;
            })
            .join(", ")}`,
        ),
      },
    );
  }
  if (json) {
    console.log(
      JSON.stringify(
        { context: "run", state: "available", connector },
        null,
        2,
      ),
    );
    return;
  }
  printRunConnectorDetails(connector);
}

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a connector")
  .argument("<slug>", "Connector slug (e.g., github)")
  .option("--agent <id>", "Show authorization state for the given agent")
  .option("--json", "Output connector status as JSON")
  .action(
    withErrorHandler(
      async (
        connectorSlug: string,
        options: { agent?: string; json?: boolean },
      ) => {
        if (isRunBoundConnectorContext()) {
          await printRunConnectorStatus(connectorSlug, options.json ?? false);
          return;
        }
        const [catalog, agentCtx] = await Promise.all([
          listConnectorCatalogStatus(),
          resolveAgentContext(options.agent),
        ]);
        const connector = findConnectorStatusItem(
          catalog.connectors,
          connectorSlug,
        );
        if (!connector) {
          throw new Error(
            `Unknown or unavailable connector: ${connectorSlug}`,
            {
              cause: new Error(
                `Available connectors: ${availableConnectorSlugs(catalog.connectors)}`,
              ),
            },
          );
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                context: "current",
                connector,
                authorization: agentCtx
                  ? {
                      agentId: agentCtx.agentId,
                      displayName: agentCtx.displayName,
                      authorized: agentCtx.authorizedConnectorSlugs.has(
                        connector.slug,
                      ),
                    }
                  : null,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(`Connector: ${chalk.cyan(connector.slug)}`);
        console.log();

        printConnectorDetails(connector);

        if (agentCtx) {
          await printAgentAction(connector, agentCtx);
        } else {
          await printStandaloneAction(connector);
        }
      },
    ),
  );
