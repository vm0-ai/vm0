import { Command } from "commander";
import { withErrorHandler } from "../../../lib/command";

const SUPPORTED_SOURCES = ["logs", "chat", "slack"] as const;
type Source = (typeof SUPPORTED_SOURCES)[number];

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

async function runLogsSource(
  _query: string,
  _options: SearchOptions,
): Promise<void> {
  throw new Error("zero search --source logs: not yet implemented");
}

async function runChatSource(
  _query: string,
  _options: SearchOptions,
): Promise<void> {
  throw new Error("zero search --source chat: not yet implemented");
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
