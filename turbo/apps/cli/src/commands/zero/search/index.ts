import { Command } from "commander";
import chalk from "chalk";
import { withErrorHandler } from "../../../lib/command";
import { runLogsSearch, type LogsSearchCliOptions } from "../logs/search";
import { searchZeroChat } from "../../../lib/api";
import type {
  ChatSearchMessage,
  ChatSearchResponse,
} from "@vm0/core/contracts/chat-threads";
import { parseTime } from "../../../lib/utils/time-parser";

const SUPPORTED_SOURCES = ["logs", "chat", "slack"] as const;
type Source = (typeof SUPPORTED_SOURCES)[number];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const SEARCH_EXPLAINER = `
Available sources:
  logs   full agent event stream (tool calls, tokens, system events) from agent runs
  chat   user/assistant text messages as shown in the web chat UI
  slack  returns a recipe for calling the Slack API directly; requires the Slack connector

Usage: zero search <query> --source <logs|chat|slack> [flags]
Run 'zero search --help' for all flags.`;

export function buildSlackRecipe(query: string): string {
  const encoded = encodeURIComponent(query);
  return `The \`slack\` source does not call Slack from this CLI. Run the
following inside an agent sandbox that has $SLACK_TOKEN available:

  curl -H "Authorization: Bearer $SLACK_TOKEN" \\
    "https://slack.com/api/search.messages?query=${encoded}"

If you don't have $SLACK_TOKEN, check the connector status:
  zero connector status slack

To verify the token and network policy end-to-end:
  zero doctor check-connector --env-name SLACK_TOKEN

Slack API docs: https://api.slack.com/methods/search.messages

Note: CLI-local flags (--limit, --since, -A/-B/-C) are ignored for the
slack source. Pass equivalents to Slack's API via count= / highlight=
query parameters instead.`;
}

interface SearchOptions {
  source: string[];
  agent?: string;
  run?: string;
  since?: string;
  limit?: string;
  afterContext?: string;
  beforeContext?: string;
  context?: string;
}

function collectSource(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const limit = parseInt(value, 10);
  if (isNaN(limit) || limit < 1 || limit > 50) {
    throw new Error("--limit must be between 1 and 50");
  }
  return limit;
}

async function runLogsSource(
  query: string,
  options: SearchOptions,
): Promise<void> {
  const logsOptions: LogsSearchCliOptions = {
    afterContext: options.afterContext,
    beforeContext: options.beforeContext,
    context: options.context,
    agent: options.agent,
    run: options.run,
    since: options.since,
    limit: options.limit,
  };
  await runLogsSearch(query, logsOptions);
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function renderChatMessage(msg: ChatSearchMessage, isMatch: boolean): void {
  const marker = isMatch ? chalk.yellow("▸") : chalk.dim("·");
  const header = `${marker} ${chalk.dim(msg.role)} ${chalk.dim(formatTimestamp(msg.createdAt))}`;
  console.log(header);
  console.log(isMatch ? msg.content : chalk.dim(msg.content));
}

function renderChatResults(response: ChatSearchResponse): void {
  let isFirst = true;
  for (const result of response.results) {
    if (!isFirst) console.log();
    isFirst = false;

    console.log(
      chalk.bold(
        `── Thread ${result.chatThreadId} (${result.agentName}) ──────────`,
      ),
    );
    for (const msg of result.contextBefore) {
      renderChatMessage(msg, false);
    }
    renderChatMessage(result.matchedMessage, true);
    for (const msg of result.contextAfter) {
      renderChatMessage(msg, false);
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

async function runChatSource(
  query: string,
  options: SearchOptions,
): Promise<void> {
  if (options.run) {
    throw new Error("--run is not supported with --source chat");
  }

  const { before, after } = parseContextOptions(options);
  const limit = parseLimit(options.limit);
  const since = options.since
    ? parseTime(options.since)
    : Date.now() - SEVEN_DAYS_MS;

  const response = await searchZeroChat({
    keyword: query,
    agent: options.agent,
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

  renderChatResults(response);
}

async function runSlackSource(
  query: string,
  _options: SearchOptions,
): Promise<void> {
  console.log(buildSlackRecipe(query));
}

export const zeroSearchCommand = new Command()
  .name("search")
  .description("Search logs, chat, or get a recipe for external sources")
  .argument("<query>", "Search query")
  .option(
    "--source <type>",
    "Source to search: logs | chat | slack (pass once)",
    collectSource,
    [] as string[],
  )
  .option("--agent <name>", "Filter by agent name")
  .option("--run <id>", "Filter by run ID")
  .option("--since <time>", "Time window (e.g., 7d, 2h)")
  .option("--limit <n>", "Maximum number of matches")
  .option("-A, --after-context <n>", "Show n items after each match")
  .option("-B, --before-context <n>", "Show n items before each match")
  .option("-C, --context <n>", "Show n items before and after each match")
  .addHelpText("after", SEARCH_EXPLAINER)
  .action(
    withErrorHandler(async (query: string, options: SearchOptions) => {
      const sources = options.source;

      if (sources.length === 0) {
        console.log(SEARCH_EXPLAINER);
        return;
      }

      if (sources.length > 1) {
        throw new Error("Only one --source is allowed.");
      }

      const source = sources[0]!;
      if (!SUPPORTED_SOURCES.includes(source as Source)) {
        throw new Error(
          `Unknown --source "${source}". Expected one of: ${SUPPORTED_SOURCES.join(", ")}`,
        );
      }

      switch (source as Source) {
        case "logs":
          await runLogsSource(query, options);
          return;
        case "chat":
          await runChatSource(query, options);
          return;
        case "slack":
          await runSlackSource(query, options);
          return;
      }
    }),
  );
