import { Command } from "commander";
import chalk from "chalk";
import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  listConnectorCatalog,
  listConnectorCatalogStatus,
  listCustomConnectors,
} from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getPlatformOrigin } from "../doctor/platform-url";
import { resolveConnectorDiscoveryAgentContext } from "./agent-context";
import { padEndAnsi, stripAnsi } from "./connected-as";
import {
  connectorDiscoveryDefinitions,
  connectorDiscoveryItems,
  connectorDiscoveryTarget,
  isConnectorDiscoveryAuthorized,
  renderConnectorDiscoveryConnectedAsCell,
  type ConnectorDiscoveryDefinition,
  type ConnectorDiscoveryItem,
} from "./discovery";
import { searchConnectorCatalog } from "./public-catalog";
import {
  currentConnectorSearchAction,
  printConnectorSearchGuidance,
  runConnectorSearchAction,
  type ConnectorSearchAction,
} from "./search-guidance";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  type RunConnectorAccountLookup,
} from "./run-account-context";

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
      return lookup.label;
    case "metadata-unavailable":
      return lookup.connectionId;
    case "not-admitted":
    case "context-unavailable":
      return chalk.dim("-");
  }
}

function renderRunAvailabilityCell(lookup: RunConnectorAccountLookup): string {
  switch (lookup.state) {
    case "available":
      return lookup.metadata.connectionStatus === "reconnect-required"
        ? chalk.yellow("no (reconnect needed)")
        : chalk.green("yes");
    case "metadata-unavailable":
      return chalk.dim("no (metadata unavailable or deleted)");
    case "not-admitted":
      return chalk.dim("no (not admitted)");
    case "context-unavailable":
      return chalk.dim("unknown (run context unavailable)");
  }
}

function renderCurrentAvailabilityCell(
  connector: ConnectorDiscoveryItem,
  agentContext: Awaited<
    ReturnType<typeof resolveConnectorDiscoveryAgentContext>
  >,
): string {
  if (connector.kind === "catalog") {
    if (connector.catalogConnector.connectionStatus === "reconnect-required") {
      return chalk.yellow("no (reconnect needed)");
    }
    if (!connector.catalogConnector.connected) {
      return chalk.dim("no (not connected)");
    }
  } else if (!connector.customConnector.connected) {
    return chalk.dim("no (not connected)");
  }

  if (
    agentContext &&
    !isConnectorDiscoveryAuthorized(connector, agentContext)
  ) {
    return chalk.dim("no (not authorized)");
  }
  return chalk.green("yes");
}

function printSearchResults<T extends ConnectorDiscoveryDefinition>(args: {
  readonly connectors: readonly T[];
  readonly keyword: string;
  readonly limit: number | undefined;
  readonly availabilityHeader: string;
  readonly renderAvailability: (connector: T) => string;
  readonly accountHeader: string;
  readonly renderAccount: (connector: T) => string;
  readonly connectionAction: (connector: T) => ConnectorSearchAction | null;
  readonly origin: string;
  readonly runBound: boolean;
  readonly callbackPrompt: string | undefined;
  readonly agentContext: Awaited<
    ReturnType<typeof resolveConnectorDiscoveryAgentContext>
  >;
}): void {
  const effectiveLimit = args.limit ?? args.connectors.length;
  const { results, total } = searchConnectorCatalog(
    args.connectors,
    args.keyword,
    effectiveLimit,
  );

  if (args.callbackPrompt !== undefined && results.length !== 1) {
    throw new Error(
      "--callback-prompt requires a single connector match. Narrow the search to the intended connector with --limit 1.",
    );
  }

  if (results.length === 0) {
    console.log("No matches found.");
    return;
  }

  const topScore = results[0]!.score;
  if (topScore < EXACT_MATCH_THRESHOLD) {
    console.log("No exact match. Showing closest:");
  }
  console.log(
    args.limit !== undefined && total > args.limit
      ? `Supported connector matches: ${total}. Showing top ${args.limit}:`
      : `Supported connector matches: ${total}.`,
  );

  const connectorSlugHeader = "SLUG";
  const availabilityCells = results.map((result) => {
    return args.renderAvailability(result.connector);
  });
  const accountCells = results.map((result) => {
    return args.renderAccount(result.connector);
  });
  const connectorSlugWidth = Math.max(
    connectorSlugHeader.length,
    ...results.map((result) => {
      return result.connector.slug.length;
    }),
  );
  const availabilityWidth = Math.max(
    args.availabilityHeader.length,
    ...availabilityCells.map((cell) => {
      return stripAnsi(cell).length;
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
    args.availabilityHeader.padEnd(availabilityWidth),
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
      padEndAnsi(availabilityCells[index]!, availabilityWidth),
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

  printConnectorSearchGuidance({
    actions: results.flatMap((result) => {
      const action = args.connectionAction(result.connector);
      return action ? [action] : [];
    }),
    origin: args.origin,
    agentId: args.agentContext?.agentId,
    runBound: args.runBound,
    callbackPrompt: args.callbackPrompt,
  });
}

export const searchCommand = new Command()
  .name("search")
  .description(
    "Search supported connectors by slug, label, category, generation type, or tag and show availability and connection links",
  )
  .argument("<keyword>", "Search keyword (case-insensitive)")
  .option("--agent <id>", "Show per-agent authorization column")
  .option(
    "--callback-prompt <prompt>",
    "Continue the current web chat after one connector action (use --limit 1)",
  )
  .option(
    "--limit <n>",
    "Maximum number of results to display (default: all matches)",
    parseLimit,
  )
  .action(
    withErrorHandler(
      async (
        keyword: string,
        options: { agent?: string; limit?: number; callbackPrompt?: string },
      ) => {
        const trimmed = keyword.trim();
        if (!trimmed) {
          throw new Error("Keyword cannot be empty.");
        }

        if (isRunBoundConnectorContext()) {
          const [{ connectors }, customConnectors, agentContext, origin] =
            await Promise.all([
              listConnectorCatalog(),
              listCustomConnectors(),
              resolveConnectorDiscoveryAgentContext(options.agent),
              getPlatformOrigin(),
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
          const runAccountForConnector = (
            connector: ConnectorDiscoveryDefinition,
          ): RunConnectorAccountLookup => {
            const lookup = lookupsByTarget.get(
              connectorAccountTargetKey(connectorDiscoveryTarget(connector)),
            );
            if (!lookup) {
              throw new Error("Missing run account lookup for connector");
            }
            return lookup;
          };
          printSearchResults({
            connectors: definitions,
            keyword: trimmed,
            limit: options.limit,
            availabilityHeader: "AVAILABLE THIS RUN",
            renderAvailability: (connector) => {
              return renderRunAvailabilityCell(
                runAccountForConnector(connector),
              );
            },
            accountHeader: "ACCOUNT USED BY THIS RUN",
            renderAccount: (connector) => {
              return renderRunAccountCell(runAccountForConnector(connector));
            },
            connectionAction: (connector) => {
              return runConnectorSearchAction(
                connector,
                runAccountForConnector(connector),
              );
            },
            origin,
            runBound: true,
            callbackPrompt: options.callbackPrompt,
            agentContext,
          });
          return;
        }

        const [{ connectors }, customConnectors, agentContext, origin] =
          await Promise.all([
            listConnectorCatalogStatus(),
            listCustomConnectors(),
            resolveConnectorDiscoveryAgentContext(options.agent),
            getPlatformOrigin(),
          ]);
        const discoveredConnectors = connectorDiscoveryItems(
          connectors,
          customConnectors,
        );
        printSearchResults({
          connectors: discoveredConnectors,
          keyword: trimmed,
          limit: options.limit,
          availabilityHeader: "AVAILABLE",
          renderAvailability: (connector) => {
            return renderCurrentAvailabilityCell(connector, agentContext);
          },
          accountHeader: "CONNECTED AS",
          renderAccount: renderConnectorDiscoveryConnectedAsCell,
          connectionAction: (connector) => {
            return currentConnectorSearchAction(connector, agentContext);
          },
          origin,
          runBound: false,
          callbackPrompt: options.callbackPrompt,
          agentContext,
        });
      },
    ),
  );
