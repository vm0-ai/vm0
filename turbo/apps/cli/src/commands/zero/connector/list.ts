import { Command } from "commander";
import chalk from "chalk";
import {
  listZeroConnectorCatalogStatus,
  listZeroCustomConnectors,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { resolveConnectorDiscoveryAgentContext } from "./agent-context";
import { padEndAnsi, stripAnsi } from "./connected-as";
import {
  connectorDiscoveryItems,
  isConnectorDiscoveryAuthorized,
  renderConnectorDiscoveryConnectedAsCell,
} from "./discovery";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all connectors and their status")
  .option("--agent <id>", "Show per-agent authorization column")
  .action(
    withErrorHandler(async (options: { agent?: string }) => {
      const [{ connectors }, customConnectors, agentCtx] = await Promise.all([
        listZeroConnectorCatalogStatus(),
        listZeroCustomConnectors(),
        resolveConnectorDiscoveryAgentContext(options.agent),
      ]);
      const discoveredConnectors = connectorDiscoveryItems(
        connectors,
        customConnectors,
      );

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
