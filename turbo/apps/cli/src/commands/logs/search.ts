import { Command } from "commander";
import chalk from "chalk";
import {
  searchLogs,
  type RunEvent,
  type LogsSearchResponse,
} from "../../lib/api";
import { parseTime } from "../../lib/utils/time-parser";
import { formatIsoTimestamp } from "../../lib/utils/time-format";
import { EventRenderer } from "../../lib/events/event-renderer";
import { EventStreamNormalizer } from "../../lib/events/event-stream-normalizer";
import { withErrorHandler } from "../../lib/command";
import { parseBoundedLogCount } from "../../lib/utils/log-pagination";
import { isSupportedFramework } from "@vm0/core/frameworks";
import { isUUID } from "../run/shared";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface SearchOptions {
  afterContext?: string;
  beforeContext?: string;
  context?: string;
  agent?: string;
  run?: string;
  since?: string;
  limit?: string;
}

function supportedSearchFramework(
  framework: string | null | undefined,
): string | undefined {
  const normalized = framework ?? undefined;
  return isSupportedFramework(normalized) ? normalized : undefined;
}

function renderSearchEvent(
  event: RunEvent,
  framework: string | null | undefined,
  renderer: EventRenderer,
  normalizer: EventStreamNormalizer,
): void {
  const parsedEvents = normalizer.process(
    event.eventData,
    supportedSearchFramework(framework),
    new Date(event.createdAt),
  );
  for (const parsed of parsedEvents) {
    renderer.render(parsed);
  }
}

function flushSearchRenderer(
  renderer: EventRenderer,
  normalizer: EventStreamNormalizer,
): void {
  for (const parsed of normalizer.flush()) {
    renderer.render(parsed);
  }
  renderer.flush();
}

/**
 * Format a run header line
 */
function formatRunHeader(
  runId: string,
  agentName: string,
  timestamp: string,
): string {
  const shortId = runId.slice(0, 8);
  const time = formatIsoTimestamp(timestamp);
  return `── Run ${shortId} (${agentName}, ${time}) ──────────`;
}

/**
 * Parse and validate context options (-A, -B, -C)
 */
function parseContextOptions(options: SearchOptions): {
  before: number;
  after: number;
} {
  const contextN = options.context
    ? parseBoundedLogCount(options.context, "--context", 0, 10)
    : 0;
  const before = options.beforeContext
    ? parseBoundedLogCount(options.beforeContext, "--before-context", 0, 10)
    : contextN;
  const after = options.afterContext
    ? parseBoundedLogCount(options.afterContext, "--after-context", 0, 10)
    : contextN;

  return { before, after };
}

/**
 * Parse --limit option with validation
 */
function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return parseBoundedLogCount(value, "--limit", 1, 50);
}

/**
 * Render search results grouped by run
 */
function renderResults(response: LogsSearchResponse): void {
  // Group results by run
  const grouped = new Map<
    string,
    { agentName: string; results: LogsSearchResponse["results"] }
  >();
  for (const result of response.results) {
    const existing = grouped.get(result.runId);
    if (existing) {
      existing.results.push(result);
    } else {
      grouped.set(result.runId, {
        agentName: result.agentName,
        results: [result],
      });
    }
  }

  // Render each group
  let isFirstGroup = true;
  for (const [runId, group] of grouped) {
    if (!isFirstGroup) {
      console.log(); // Separator between runs
    }
    isFirstGroup = false;

    const firstTimestamp = group.results[0]!.matchedEvent.createdAt;
    console.log(
      chalk.bold(formatRunHeader(runId, group.agentName, firstTimestamp)),
    );

    for (const result of group.results) {
      const renderer = new EventRenderer({
        showTimestamp: true,
        verbose: false,
      });
      const normalizer = new EventStreamNormalizer();

      for (const event of result.contextBefore) {
        renderSearchEvent(event, result.framework, renderer, normalizer);
      }
      renderSearchEvent(
        result.matchedEvent,
        result.framework,
        renderer,
        normalizer,
      );
      for (const event of result.contextAfter) {
        renderSearchEvent(event, result.framework, renderer, normalizer);
      }
      flushSearchRenderer(renderer, normalizer);
    }
  }

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.dim(
        `  Showing first ${response.results.length} matches. Use --limit to see more.`,
      ),
    );
  }
}

export const searchCommand = new Command()
  .name("search")
  .description("Search agent events across runs")
  .argument("<keyword>", "Search keyword")
  .option("-A, --after-context <n>", "Show n events after each match")
  .option("-B, --before-context <n>", "Show n events before each match")
  .option("-C, --context <n>", "Show n events before and after each match")
  .option("--agent <id>", "Filter by agent ID")
  .option("--run <id>", "Filter by specific run ID")
  .option("--since <time>", "Search logs since (default: 7d)")
  .option("--limit <n>", "Maximum number of matches (default: 20)")
  .action(
    withErrorHandler(async (keyword: string, options: SearchOptions) => {
      if (options.agent && !isUUID(options.agent)) {
        console.error(
          chalk.red(`✗ Invalid agent ID "${options.agent}" — expected a UUID`),
        );
        console.error(chalk.dim("  Run: vm0 run list    to find agent IDs"));
        process.exit(1);
      }

      if (options.run && !isUUID(options.run)) {
        console.error(
          chalk.red(`✗ Invalid run ID "${options.run}" — expected a UUID`),
        );
        console.error(chalk.dim("  Run: vm0 run list    to find run IDs"));
        process.exit(1);
      }

      const { before, after } = parseContextOptions(options);
      const since =
        options.since !== undefined
          ? parseTime(options.since)
          : Date.now() - SEVEN_DAYS_MS;
      const limit = parseLimit(options.limit);

      const response = await searchLogs({
        keyword,
        agentId: options.agent,
        runId: options.run,
        since,
        limit,
        before,
        after,
      });

      if (response.results.length === 0) {
        console.log(chalk.dim("No matches found"));
        console.log(
          chalk.dim(
            "  Try a broader search with --since 30d or a different keyword",
          ),
        );
        return;
      }

      renderResults(response);
    }),
  );
