import { Command } from "commander";
import chalk from "chalk";
import { listZeroConnectorCatalogStatus } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { resolveAgentContext } from "./agent-context";
import { padEndAnsi, renderConnectedAsCell, stripAnsi } from "./connected-as";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all connectors and their status")
  .option("--agent <id>", "Show per-agent authorization column")
  .action(
    withErrorHandler(async (options: { agent?: string }) => {
      const [{ connectors }, agentCtx] = await Promise.all([
        listZeroConnectorCatalogStatus(),
        resolveAgentContext(options.agent),
      ]);

      const allTypes = connectors.map((connector) => {
        return connector.connectorRef;
      });

      const typeWidth = Math.max(
        4,
        ...allTypes.map((t) => {
          return t.length;
        }),
      );

      const connectedAsHeader = "CONNECTED AS";
      const connectedCells = connectors.map((connector) => {
        return renderConnectedAsCell(connector);
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
        "TYPE".padEnd(typeWidth),
        connectedAsHeader.padEnd(connectedAsWidth),
      ];
      if (authorizedHeader) headerParts.push(authorizedHeader);
      console.log(chalk.dim(headerParts.join("  ")));

      // Print rows
      for (let i = 0; i < allTypes.length; i++) {
        const type = allTypes[i]!;
        const connectedCell = padEndAnsi(connectedCells[i]!, connectedAsWidth);
        const parts = [type.padEnd(typeWidth), connectedCell];
        if (agentCtx) {
          parts.push(
            agentCtx.authorizedTypes.has(type)
              ? chalk.green("✓")
              : chalk.dim("-"),
          );
        }
        console.log(parts.join("  "));
      }
    }),
  );
