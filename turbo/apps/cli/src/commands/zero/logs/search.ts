import { Command } from "commander";
import chalk from "chalk";
import {
  searchZeroLogs,
  type RunEvent,
  type LogsSearchResponse,
} from "../../../lib/api";
import { parseTime } from "../../../lib/utils/time-parser";
import { ClaudeEventParser } from "../../../lib/events/claude-event-parser";
import { EventRenderer } from "../../../lib/events/event-renderer";
import { withErrorHandler } from "../../../lib/command";
import { isUUID } from "../../run/shared";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface LogsSearchCliOptions {
  afterContext?: string;
  beforeContext?: string;
  context?: string;
  agent?: string;
  run?: string;
  since?: string;
  limit?: string;
}

function renderEvent(event: RunEvent, renderer: EventRenderer): void {
  const eventData = event.eventData as Record<string, unknown>;
  const parsed = ClaudeEventParser.parse(eventData);
  if (parsed) {
    parsed.timestamp = new Date(event.createdAt);
    renderer.render(parsed);
  }
}

function formatRunHeader(
  runId: string,
  agentName: string,
  timestamp: string,
): string {
  const time = new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `── Run ${runId} (${agentName}, ${time}) ──────────`;
}

function parseContextOptions(options: LogsSearchCliOptions): {
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

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const limit = parseInt(value, 10);
  if (isNaN(limit) || limit < 1 || limit > 50) {
    throw new Error("--limit must be between 1 and 50");
  }
  return limit;
}

function renderResults(response: LogsSearchResponse): void {
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

  let isFirstGroup = true;
  for (const [runId, group] of grouped) {
    if (!isFirstGroup) {
      console.log();
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

export async function runLogsSearch(
  keyword: string,
  options: LogsSearchCliOptions,
): Promise<void> {
  const { before, after } = parseContextOptions(options);

  if (options.run && !isUUID(options.run)) {
    console.error(
      chalk.red(`✗ Invalid run ID "${options.run}" — expected a UUID`),
    );
    console.error(chalk.dim("  Run: zero logs list    to find run IDs"));
    process.exit(1);
  }

  const since = options.since
    ? parseTime(options.since)
    : Date.now() - SEVEN_DAYS_MS;
  const limit = parseLimit(options.limit);

  const response = await searchZeroLogs({
    keyword,
    agent: options.agent,
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
}

export const searchCommand = new Command()
  .name("search")
  .description("Search agent events across runs")
  .argument("<keyword>", "Search keyword")
  .option("-A, --after-context <n>", "Show n events after each match")
  .option("-B, --before-context <n>", "Show n events before each match")
  .option("-C, --context <n>", "Show n events before and after each match")
  .option("--agent <name>", "Filter by agent name")
  .option("--run <id>", "Filter by specific run ID")
  .option("--since <time>", "Search logs since (default: 7d)")
  .option("--limit <n>", "Maximum number of matches (default: 20)")
  .addHelpText(
    "after",
    `
Examples:
  zero logs search "error"
  zero logs search "timeout" --agent my-agent -C 2
  zero logs search "failed" --since 30d --limit 50`,
  )
  .action(
    withErrorHandler(async (keyword: string, options: LogsSearchCliOptions) => {
      await runLogsSearch(keyword, options);
    }),
  );
