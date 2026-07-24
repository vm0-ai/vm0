import chalk from "chalk";
import { Command } from "commander";

import { withErrorHandler } from "../../../lib/command";
import { formatIsoTimestamp } from "../../../lib/utils/time-format";
import { parseBoundedLogCount } from "../../../lib/utils/log-pagination";
import { isUuid } from "../../../lib/utils/uuid";
import { syncCachedChatThreads } from "./chat-thread-cache";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface ListOptions {
  readonly agent?: string;
  readonly json?: boolean;
  readonly limit?: string;
}

function printUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

function resolveAgentId(flagAgentId: string | undefined): string {
  const agentId = flagAgentId?.trim() || process.env.ZERO_AGENT_ID?.trim();
  if (!agentId) {
    printUsageError(
      "ZERO_AGENT_ID is not set",
      "Pass --agent <agent-id> or run inside an agent sandbox.",
    );
  }
  if (!isUuid(agentId)) {
    printUsageError(
      `Invalid agent ID "${agentId}" — expected a UUID`,
      "Pass a valid UUID with --agent <agent-id>.",
    );
  }
  return agentId;
}

function titleForDisplay(title: string | null): string {
  return (title ?? "(untitled)").replace(/\s+/g, " ");
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List web chat threads for an agent")
  .option("--agent <id>", "Filter by Zero agent ID (defaults to ZERO_AGENT_ID)")
  .option(
    "--limit <n>",
    `Maximum number of threads to print (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  List this agent's chats:  zero chat list
  List another agent:       zero chat list --agent <agent-id>
  Limit the output:         zero chat list --limit 10
  Print JSON:               zero chat list --json

Notes:
  - Defaults --agent to ZERO_AGENT_ID
  - Authenticates via ZERO_TOKEN (requires chat-thread:read capability)
  - Replays cached snapshot and incremental chat thread events`,
  )
  .action(
    withErrorHandler(async (options: ListOptions) => {
      const agentId = resolveAgentId(options.agent);
      const limit =
        options.limit === undefined
          ? DEFAULT_LIMIT
          : parseBoundedLogCount(options.limit, "--limit", 1, MAX_LIMIT);
      const allThreads = await syncCachedChatThreads();
      const matchingThreads = allThreads.filter((thread) => {
        return thread.agentId === agentId;
      });
      const threads = matchingThreads.slice(0, limit);

      if (options.json) {
        console.log(
          JSON.stringify({
            agentId,
            total: matchingThreads.length,
            threads,
          }),
        );
        return;
      }

      if (threads.length === 0) {
        console.log(chalk.dim("No chat threads found"));
        return;
      }

      const header = [
        "THREAD ID".padEnd(38),
        "SORTED".padEnd(20),
        "PINNED".padEnd(6),
        "TITLE",
      ].join("  ");
      console.log(chalk.dim(header));
      for (const thread of threads) {
        console.log(
          [
            thread.id.padEnd(38),
            formatIsoTimestamp(thread.sortAt).padEnd(20),
            (thread.pinnedAt === null ? "-" : "yes").padEnd(6),
            titleForDisplay(thread.title),
          ].join("  "),
        );
      }

      if (threads.length < matchingThreads.length) {
        console.log();
        console.log(
          chalk.dim(
            `  Showing ${threads.length} of ${matchingThreads.length} threads. Use --limit to adjust.`,
          ),
        );
      }
    }),
  );
