import { Command } from "commander";
import chalk from "chalk";
import {
  searchZeroLogs,
  type RunEvent,
  type LogsSearchResponse,
} from "../../../lib/api";
import { parseTime } from "../../../lib/utils/time-parser";
import { formatIsoTimestamp } from "../../../lib/utils/time-format";
import { EventRenderer } from "../../../lib/events/event-renderer";
import { EventStreamNormalizer } from "../../../lib/events/event-stream-normalizer";
import { withErrorHandler } from "../../../lib/command";
import { isUUID } from "../../run/shared";
import { parseBoundedLogCount } from "../../../lib/utils/log-pagination";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface LogsSearchCliOptions {
  afterContext?: string;
  beforeContext?: string;
  context?: string;
  agentId?: string;
  run?: string;
  since?: string;
  limit?: string;
}

interface LogsSearchCommandOptions extends Omit<
  LogsSearchCliOptions,
  "agentId"
> {
  agent?: string;
}

function renderSearchEvent(
  event: RunEvent,
  framework: string | null | undefined,
  renderer: EventRenderer,
  normalizer: EventStreamNormalizer,
): void {
  const parsedEvents = normalizer.process(
    event.eventData,
    framework ?? undefined,
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

function formatRunHeader(
  runId: string,
  agentName: string,
  timestamp: string,
): string {
  const time = formatIsoTimestamp(timestamp);
  return `── Run ${runId} (${agentName}, ${time}) ──────────`;
}

function parseContextOptions(options: LogsSearchCliOptions): {
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

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return parseBoundedLogCount(value, "--limit", 1, 50);
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
    agentId: options.agentId,
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
  .option("--agent <id>", "Filter by Zero agent ID")
  .option("--run <id>", "Filter by specific run ID")
  .option("--since <time>", "Search logs since (default: 7d)")
  .option("--limit <n>", "Maximum number of matches (default: 20)")
  .addHelpText(
    "after",
    `
Examples:
  zero logs search "error"
  zero logs search "timeout" --agent 123e4567-e89b-12d3-a456-426614174000 -C 2
  zero logs search "failed" --since 30d --limit 50`,
  )
  .action(
    withErrorHandler(
      async (keyword: string, options: LogsSearchCommandOptions) => {
        const { agent, ...searchOptions } = options;
        await runLogsSearch(keyword, { ...searchOptions, agentId: agent });
      },
    ),
  );
