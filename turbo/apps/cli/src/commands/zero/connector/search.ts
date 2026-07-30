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
import { searchConnectorCatalog } from "./public-catalog";

const DEFAULT_LIMIT = 5;
const EXACT_MATCH_THRESHOLD = 80;

function parseLimit(raw: string): number {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer, got "${raw}".`);
  }
  return n;
}

export const searchCommand = new Command()
  .name("search")
  .description(
    "Search connectors by slug, label, category, generation type, or tag",
  )
  .argument("<keyword>", "Search keyword (case-insensitive)")
  .option("--agent <id>", "Show per-agent authorization column")
  .option(
    "--limit <n>",
    `Maximum number of results to display (default ${DEFAULT_LIMIT})`,
    parseLimit,
    DEFAULT_LIMIT,
  )
  .action(
    withErrorHandler(
      async (keyword: string, options: { agent?: string; limit: number }) => {
        const trimmed = keyword.trim();
        if (!trimmed) {
          throw new Error("Keyword cannot be empty.");
        }

        const [{ connectors }, customConnectors, agentCtx] = await Promise.all([
          listZeroConnectorCatalogStatus(),
          listZeroCustomConnectors(),
          resolveConnectorDiscoveryAgentContext(options.agent),
        ]);
        const { results, total } = searchConnectorCatalog(
          connectorDiscoveryItems(connectors, customConnectors),
          trimmed,
          options.limit,
        );

        if (results.length === 0) {
          console.log("No matches found.");
          return;
        }

        const topScore = results[0]!.score;
        if (topScore < EXACT_MATCH_THRESHOLD) {
          console.log("No exact match. Showing closest:");
        }
        if (total > options.limit) {
          console.log(`Too many results (top ${options.limit} of ${total}):`);
        }

        const connectorSlugHeader = "SLUG";
        const connectedAsHeader = "CONNECTED AS";

        const connectedCells = results.map((r) => {
          return renderConnectorDiscoveryConnectedAsCell(r.connector);
        });

        const connectorSlugWidth = Math.max(
          connectorSlugHeader.length,
          ...results.map((r) => {
            return r.connector.slug.length;
          }),
        );
        const connectedAsWidth = Math.max(
          connectedAsHeader.length,
          ...connectedCells.map((c) => {
            return stripAnsi(c).length;
          }),
        );

        const headerParts = [
          connectorSlugHeader.padEnd(connectorSlugWidth),
          connectedAsHeader.padEnd(connectedAsWidth),
        ];
        if (agentCtx) {
          headerParts.push(`AUTHORIZED FOR ${agentCtx.displayName}`);
        }
        console.log(chalk.dim(headerParts.join("  ")));

        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const parts = [
            result.connector.slug.padEnd(connectorSlugWidth),
            padEndAnsi(connectedCells[i]!, connectedAsWidth),
          ];
          if (agentCtx) {
            parts.push(
              isConnectorDiscoveryAuthorized(result.connector, agentCtx)
                ? chalk.green("✓")
                : chalk.dim("-"),
            );
          }
          console.log(parts.join("  "));
        }
      },
    ),
  );
