import { Command } from "commander";
import chalk from "chalk";
import {
  listConnectorCatalogStatus,
  listCustomConnectors,
} from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveConnectorDiscoveryAgentContext } from "./agent-context";
import { padEndAnsi, stripAnsi } from "./connected-as";
import {
  connectorDiscoveryItems,
  isConnectorDiscoveryAuthorized,
  renderConnectorDiscoveryConnectedAsCell,
} from "./discovery";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "./run-account-context";

function runAccountCell(connector: RunConnectorAccountEntry): string {
  if (connector.account.state === "available") {
    return `${connector.account.label} (${connector.account.connectionId})`;
  }
  if (connector.account.state === "metadata-unavailable") {
    return `${connector.account.connectionId} (metadata unavailable or deleted)`;
  }
  return "(unavailable for this run)";
}

async function printRunConnectorList(json: boolean): Promise<void> {
  const view = await resolveRunConnectorAccountView();
  if (json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  if (view.state === "unavailable") {
    console.log(runConnectorAccountUnavailableMessage(view.reason));
    return;
  }
  const slugWidth = Math.max(
    4,
    ...view.connectors.map((connector) => {
      return connector.slug.length;
    }),
  );
  console.log(
    chalk.dim(
      ["SLUG".padEnd(slugWidth), "ACCOUNT USED BY THIS RUN"].join("  "),
    ),
  );
  for (const connector of view.connectors) {
    console.log(
      [connector.slug.padEnd(slugWidth), runAccountCell(connector)].join("  "),
    );
  }
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all connectors and their status")
  .option("--agent <id>", "Show per-agent authorization column")
  .option("--json", "Output connector status as JSON")
  .action(
    withErrorHandler(async (options: { agent?: string; json?: boolean }) => {
      if (isRunBoundConnectorContext()) {
        await printRunConnectorList(options.json ?? false);
        return;
      }
      const [{ connectors }, customConnectors, agentCtx] = await Promise.all([
        listConnectorCatalogStatus(),
        listCustomConnectors(),
        resolveConnectorDiscoveryAgentContext(options.agent),
      ]);
      const discoveredConnectors = connectorDiscoveryItems(
        connectors,
        customConnectors,
      );

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              context: "current",
              connectors: discoveredConnectors.map((connector) => {
                return connector.kind === "catalog"
                  ? {
                      kind: "builtin",
                      slug: connector.slug,
                      label: connector.label,
                      connectionStatus:
                        connector.catalogConnector.connectionStatus,
                      connection: connector.catalogConnector.connection,
                      authorized: agentCtx
                        ? isConnectorDiscoveryAuthorized(connector, agentCtx)
                        : null,
                    }
                  : {
                      kind: "custom",
                      id: connector.customConnector.id,
                      slug: connector.slug,
                      label: connector.label,
                      connected: connector.customConnector.connected,
                      missingRequiredFields:
                        connector.customConnector.missingRequiredFields,
                      authorized: agentCtx
                        ? isConnectorDiscoveryAuthorized(connector, agentCtx)
                        : null,
                    };
              }),
            },
            null,
            2,
          ),
        );
        return;
      }

      const connectorSlugs = discoveredConnectors.map((connector) => {
        return connector.slug;
      });

      const connectorSlugWidth = Math.max(
        4,
        ...connectorSlugs.map((connectorSlug) => {
          return connectorSlug.length;
        }),
      );

      const connectedAsHeader = "CONNECTED AS";
      const connectedCells = discoveredConnectors.map((connector) => {
        return renderConnectorDiscoveryConnectedAsCell(connector);
      });
      const connectedAsWidth = Math.max(
        connectedAsHeader.length,
        ...connectedCells.map((c) => {
          return stripAnsi(c).length;
        }),
      );

      const authorizedHeader = agentCtx
        ? `AUTHORIZED FOR ${agentCtx.displayName}`
        : null;

      // Print header
      const headerParts = [
        "SLUG".padEnd(connectorSlugWidth),
        connectedAsHeader.padEnd(connectedAsWidth),
      ];
      if (authorizedHeader) headerParts.push(authorizedHeader);
      console.log(chalk.dim(headerParts.join("  ")));

      // Print rows
      for (let i = 0; i < connectorSlugs.length; i++) {
        const connector = discoveredConnectors[i]!;
        const connectorSlug = connectorSlugs[i]!;
        const connectedCell = padEndAnsi(connectedCells[i]!, connectedAsWidth);
        const parts = [connectorSlug.padEnd(connectorSlugWidth), connectedCell];
        if (agentCtx) {
          parts.push(
            isConnectorDiscoveryAuthorized(connector, agentCtx)
              ? chalk.green("✓")
              : chalk.dim("-"),
          );
        }
        console.log(parts.join("  "));
      }
    }),
  );
