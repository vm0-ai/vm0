import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/api-contracts/contracts/connectors";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { listZeroConnectors } from "../../../lib/api";
import { getActiveOrg } from "../../../lib/api/config";
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
      const [{ connectors }, orgId, agentCtx] = await Promise.all([
        listZeroConnectors(),
        getActiveOrg(),
        resolveAgentContext(options.agent),
      ]);
      const connectedMap = new Map(
        connectors.map((c) => {
          return [c.type, c];
        }),
      );

      const allTypesRaw = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
      const allTypes: ConnectorType[] = [];
      for (const type of allTypesRaw) {
        const config = CONNECTOR_TYPES[type];
        const flag = config.featureFlag;
        const hasApiToken = "api-token" in config.authMethods;
        if (
          flag &&
          !isFeatureEnabled(flag, { orgId }) &&
          (!hasApiToken || config.strictFeatureFlag)
        ) {
          continue;
        }
        allTypes.push(type);
      }

      const typeWidth = Math.max(
        4,
        ...allTypes.map((t) => {
          return t.length;
        }),
      );

      const connectedAsHeader = "CONNECTED AS";
      const connectedCells = allTypes.map((type) => {
        return renderConnectedAsCell(connectedMap.get(type));
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
