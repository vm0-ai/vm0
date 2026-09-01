import { Command } from "commander";
import chalk from "chalk";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { searchChat } from "../../lib/api/domains/chat";
import type {
  ChatSearchMessage,
  ChatSearchResponse,
} from "@okouai/api-contracts/contracts/chat-threads";
import { parseTime } from "../../lib/utils/time-parser";
import { formatIsoTimestamp } from "../../lib/utils/time-format";
import { parseBoundedLogCount } from "../../lib/utils/log-pagination";
import { parseSearchQuery } from "../../lib/utils/search-query";
import { isUuid } from "../../lib/utils/uuid";

const SUPPORTED_SOURCES = ["agent-session", "chat", "slack"] as const;
type Source = (typeof SUPPORTED_SOURCES)[number];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const SEARCH_EXPLAINER = `
Available sources:
  agent-session  locates local Claude Code and Codex session files for direct analysis
  chat           user/assistant text messages as shown in the web chat UI
  slack          returns a recipe for calling the Slack API directly; requires the Slack connector

Usage: okou search <query> --source <agent-session|chat|slack> [flags]
Run 'okou search --help' for all flags.`;

function buildAgentSessionGuidance(query: string): string {
  return `Agent session files are available at both locations:

  Claude Code: /home/user/.claude/projects/-home-user-workspace/
  Codex:       /home/user/.codex/sessions/

A single thread may use both Claude Code and Codex, so inspect both locations.
You can analyze these session files directly for: ${query}`;
}

export function buildSlackRecipe(query: string): string {
  const encoded = encodeURIComponent(query);
  return `The \`slack\` source does not call Slack from this CLI. Run the
following inside an agent sandbox that has $SLACK_TOKEN available:

  curl -H "Authorization: Bearer $SLACK_TOKEN" \\
    "https://slack.com/api/search.messages?query=${encoded}"

If you don't have $SLACK_TOKEN, check the connector status:
  okou connector status slack

To verify the token and network policy end-to-end:
  okou connector check --env-name SLACK_TOKEN

Slack API docs: https://api.slack.com/methods/search.messages

Note: CLI-local flags (--limit, --since) are ignored for the slack source.
Pass equivalents to Slack's API via count= / highlight=
query parameters instead.`;
}

interface SearchOptions {
  source: string[];
  agent?: string;
  since?: string;
  limit?: string;
}

function collectSource(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parseBoundedLogCount(value, "--limit", 1, 50);
}

function formatTimestamp(iso: string): string {
  return formatIsoTimestamp(iso);
}

function renderChatMessage(msg: ChatSearchMessage): void {
  const header = `${chalk.yellow("▸")} ${chalk.dim(msg.role)} ${chalk.dim(formatTimestamp(msg.createdAt))}`;
  console.log(header);
  console.log(msg.content);
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
    renderChatMessage(result.matchedMessage);
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
  if (options.agent !== undefined && !isUuid(options.agent)) {
    console.error(
      chalk.red(`✗ Invalid agent ID "${options.agent}" — expected a UUID`),
    );
    process.exit(1);
  }

  const limit = parseLimit(options.limit);
  const since =
    options.since !== undefined
      ? parseTime(options.since)
      : Date.now() - SEVEN_DAYS_MS;

  const response = await searchChat({
    keyword: query,
    agentId: options.agent,
    since,
    limit,
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

async function runAgentSessionSource(
  query: string,
  _options: SearchOptions,
): Promise<void> {
  console.log(buildAgentSessionGuidance(query));
}

export const searchCommand = new Command()
  .name("search")
  .description("Search chat or locate sources for direct analysis")
  .argument("<query>", "Search query")
  .option(
    "--source <type>",
    "Source to search: agent-session | chat | slack (pass once)",
    collectSource,
    [] as string[],
  )
  .option("--agent <id>", "Filter by agent ID")
  .option("--since <time>", "Time window (e.g., 7d, 2h)")
  .option("--limit <n>", "Maximum number of matches")
  .addHelpText("after", SEARCH_EXPLAINER)
  .action(
    withErrorHandler(async (query: string, options: SearchOptions) => {
      const searchQuery = parseSearchQuery(query, "Query");
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
        case "agent-session":
          await runAgentSessionSource(searchQuery, options);
          return;
        case "chat":
          await runChatSource(searchQuery, options);
          return;
        case "slack":
          await runSlackSource(searchQuery, options);
          return;
      }
    }),
  );
