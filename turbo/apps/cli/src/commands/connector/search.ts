import { Command } from "commander";
import chalk from "chalk";
import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  listConnectorCatalog,
  listConnectorCatalogStatus,
  listCustomConnectors,
} from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveConnectorDiscoveryAgentContext } from "./agent-context";
import { padEndAnsi, stripAnsi } from "./connected-as";
import {
  connectorDiscoveryDefinitions,
  connectorDiscoveryItems,
  connectorDiscoveryTarget,
  isConnectorDiscoveryAuthorized,
  renderConnectorDiscoveryConnectedAsCell,
  type ConnectorDiscoveryDefinition,
} from "./discovery";
import { searchConnectorCatalog } from "./public-catalog";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  type RunConnectorAccountLookup,
} from "./run-account-context";

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

function renderRunAccountCell(lookup: RunConnectorAccountLookup): string {
  switch (lookup.state) {
    case "available":
      return lookup.metadata.connectionStatus === "reconnect-required"
        ? chalk.yellow(`${lookup.label} (reconnect needed)`)
        : lookup.label;
    case "metadata-unavailable":
      return chalk.dim(
        `${lookup.connectionId} (metadata unavailable or deleted)`,
      );
    case "not-admitted":
      return chalk.dim("(not admitted for this run)");
    case "context-unavailable":
      return chalk.dim("(run account unavailable)");
  }
}

function printSearchResults<T extends ConnectorDiscoveryDefinition>(args: {
  readonly connectors: readonly T[];
  readonly keyword: string;
  readonly limit: number;
  readonly accountHeader: string;
  readonly renderAccount: (connector: T) => string;
  readonly agentContext: Awaited<
    ReturnType<typeof resolveConnectorDiscoveryAgentContext>
  >;
}): void {
  const { results, total } = searchConnectorCatalog(
    args.connectors,
    args.keyword,
    args.limit,
  );

  if (results.length === 0) {
    console.log("No matches found.");
    return;
  }

  const topScore = results[0]!.score;
  if (topScore < EXACT_MATCH_THRESHOLD) {
    console.log("No exact match. Showing closest:");
  }
  if (total > args.limit) {
    console.log(`Too many results (top ${args.limit} of ${total}):`);
  }

  const connectorSlugHeader = "SLUG";
  const accountCells = results.map((result) => {
    return args.renderAccount(result.connector);
  });
  const connectorSlugWidth = Math.max(
    connectorSlugHeader.length,
    ...results.map((result) => {
      return result.connector.slug.length;
    }),
  );
  const accountWidth = Math.max(
    args.accountHeader.length,
    ...accountCells.map((cell) => {
      return stripAnsi(cell).length;
    }),
  );

  const headerParts = [
    connectorSlugHeader.padEnd(connectorSlugWidth),
    args.accountHeader.padEnd(accountWidth),
  ];
  if (args.agentContext) {
    headerParts.push(`AUTHORIZED FOR ${args.agentContext.displayName}`);
  }
  console.log(chalk.dim(headerParts.join("  ")));

  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const parts = [
      result.connector.slug.padEnd(connectorSlugWidth),
      padEndAnsi(accountCells[index]!, accountWidth),
    ];
    if (args.agentContext) {
      parts.push(
        isConnectorDiscoveryAuthorized(result.connector, args.agentContext)
          ? chalk.green("✓")
          : chalk.dim("-"),
      );
    }
    console.log(parts.join("  "));
  }
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

        if (isRunBoundConnectorContext()) {
          const [{ connectors }, customConnectors, agentContext] =
            await Promise.all([
              listConnectorCatalog(),
              listCustomConnectors(),
              resolveConnectorDiscoveryAgentContext(options.agent),
            ]);
          const definitions = connectorDiscoveryDefinitions(
            connectors,
            customConnectors,
          );
          const targets = definitions.map(connectorDiscoveryTarget);
          const lookups = await resolveRunConnectorAccountLookups(targets);
          const lookupsByTarget = new Map(
            targets.map((target, index) => {
              return [
                connectorAccountTargetKey(target),
                lookups[index]!,
              ] as const;
            }),
          );
          printSearchResults({
            connectors: definitions,
            keyword: trimmed,
            limit: options.limit,
            accountHeader: "ACCOUNT USED BY THIS RUN",
            renderAccount: (connector) => {
              const lookup = lookupsByTarget.get(
                connectorAccountTargetKey(connectorDiscoveryTarget(connector)),
              );
              if (!lookup) {
                throw new Error("Missing run account lookup for connector");
              }
              return renderRunAccountCell(lookup);
            },
            agentContext,
          });
          return;
        }

        const [{ connectors }, customConnectors, agentContext] =
          await Promise.all([
            listConnectorCatalogStatus(),
            listCustomConnectors(),
            resolveConnectorDiscoveryAgentContext(options.agent),
          ]);
        printSearchResults({
          connectors: connectorDiscoveryItems(connectors, customConnectors),
          keyword: trimmed,
          limit: options.limit,
          accountHeader: "CONNECTED AS",
          renderAccount: renderConnectorDiscoveryConnectedAsCell,
          agentContext,
        });
      },
    ),
  );
