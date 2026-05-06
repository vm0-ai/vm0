import { Command } from "commander";
import chalk from "chalk";
import {
  searchLogs,
  type RunEvent,
  type LogsSearchResponse,
} from "../../lib/api";
import { parseTime } from "../../lib/utils/time-parser";
import { parseEvent } from "../../lib/events/event-parser-factory";
import { EventRenderer } from "../../lib/events/event-renderer";
import { withErrorHandler } from "../../lib/command";

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

/**
 * Render a single agent event using EventRenderer.
 *
 * Search responses do not yet carry a per-result framework, so we let the
 * factory default to claude-code. Codex events in search results render as
 * nothing until the search contract is extended (tracked separately).
 */
function renderEvent(event: RunEvent, renderer: EventRenderer): void {
  const eventData = event.eventData as Record<string, unknown>;
  const parsed = parseEvent(eventData);
  if (parsed) {
    parsed.timestamp = new Date(event.createdAt);
    renderer.render(parsed);
  }
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
  const time = new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `── Run ${shortId} (${agentName}, ${time}) ──────────`;
}

/**
 * Parse and validate context options (-A, -B, -C)
 */
function parseContextOptions(options: SearchOptions): {
  before: number;
  after: number;
} {
  const contextN = options.context ? parseInt(options.context, 10) : 0;
  const before = options.beforeContext
    ? parseInt(options.beforeContext, 10)
    : contextN;
  const after = options.afterContext
    ? parseInt(options.afterContext, 10)
    : contextN;

  if (isNaN(before) || before < 0 || before > 10) {
    throw new Error("--before-context must be between 0 and 10");
  }
  if (isNaN(after) || after < 0 || after > 10) {
    throw new Error("--after-context must be between 0 and 10");
  }

  return { before, after };
}

/**
 * Parse --limit option with validation
 */
function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const limit = parseInt(value, 10);
  if (isNaN(limit) || limit < 1 || limit > 50) {
    throw new Error("--limit must be between 1 and 50");
  }
  return limit;
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
        buffered: false,
      });

      for (const event of result.contextBefore) {
        renderEvent(event, renderer);
      }
      renderEvent(result.matchedEvent, renderer);
      for (const event of result.contextAfter) {
        renderEvent(event, renderer);
      }
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
      const { before, after } = parseContextOptions(options);
      const since = options.since
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
