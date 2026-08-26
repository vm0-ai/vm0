import chalk from "chalk";
import { Command } from "commander";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { listChatThreadUnreads } from "../../lib/api/domains/chat";
import { formatIsoTimestamp } from "../../lib/utils/time-format";
import { parseBoundedLogCount } from "../../lib/utils/log-pagination";
import { isUuid } from "../../lib/utils/uuid";
import { getOkouAgentId } from "../../lib/okou-env";
import { syncCachedChatThreads } from "./chat-thread-cache";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_UNREAD_REQUEST_CONCURRENCY = 4;

interface ListOptions {
  readonly agent?: string;
  readonly allAgents?: boolean;
  readonly json?: boolean;
  readonly limit?: string;
  readonly unread?: boolean;
}

type UnreadChatThread = EventDrivenChatThread & {
  readonly unreadAt: string;
};

function printUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

function resolveAgentId(flagAgentId: string | undefined): string {
  const agentId = flagAgentId?.trim() || getOkouAgentId()?.trim();
  if (!agentId) {
    printUsageError(
      "OKOU_AGENT_ID is not set",
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

async function unreadTimestampsByThread(
  agentIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unreadTimestamps = new Map<string, string>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < agentIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const agentId = agentIds[index];
      if (agentId === undefined) {
        throw new Error(`Unread agent ${index} is missing`);
      }
      const unreads = await listChatThreadUnreads({ agentId });
      for (const unread of unreads) {
        unreadTimestamps.set(unread.threadId, unread.unreadAt);
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(MAX_UNREAD_REQUEST_CONCURRENCY, agentIds.length),
      },
      async () => {
        await worker();
      },
    ),
  );
  return unreadTimestamps;
}

function compareUnreadThreads(
  left: UnreadChatThread,
  right: UnreadChatThread,
): number {
  return (
    right.unreadAt.localeCompare(left.unreadAt) ||
    right.id.localeCompare(left.id)
  );
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List web chat threads")
  .option("--agent <id>", "Filter by agent ID (defaults to OKOU_AGENT_ID)")
  .option("--all-agents", "List threads across all agents in the current org")
  .option("--unread", "List only canonical unread threads")
  .option(
    "--limit <n>",
    `Maximum number of threads to print (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  List this agent's chats:  okou chat list
  List another agent:       okou chat list --agent <agent-id>
  List unread chats:        okou chat list --unread
  Unread across all agents: okou chat list --unread --all-agents
  Limit the output:         okou chat list --limit 10
  Print JSON:               okou chat list --json

Notes:
  - Defaults --agent to OKOU_AGENT_ID
  - --all-agents and --agent are mutually exclusive
  - Listing and --unread require chat-thread:read
  - Reading a selected thread with okou chat messages requires chat-event:read
  - Authenticates via OKOU_TOKEN
  - Replays cached snapshot and incremental chat thread events`,
  )
  .action(
    withErrorHandler(async (options: ListOptions) => {
      if (options.allAgents && options.agent !== undefined) {
        printUsageError(
          "--all-agents and --agent are mutually exclusive",
          "Choose one agent with --agent, or omit it to list all agents.",
        );
      }
      const agentId = options.allAgents
        ? undefined
        : resolveAgentId(options.agent);
      const limit =
        options.limit === undefined
          ? DEFAULT_LIMIT
          : parseBoundedLogCount(options.limit, "--limit", 1, MAX_LIMIT);
      const allThreads = await syncCachedChatThreads();
      const agentThreads =
        agentId === undefined
          ? allThreads
          : allThreads.filter((thread) => {
              return thread.agentId === agentId;
            });
      let matchingThreads: readonly (
        | EventDrivenChatThread
        | UnreadChatThread
      )[];
      if (options.unread) {
        const unreadTimestamps = await unreadTimestampsByThread(
          agentId === undefined
            ? [
                ...new Set(
                  agentThreads.map((thread) => {
                    return thread.agentId;
                  }),
                ),
              ]
            : [agentId],
        );
        matchingThreads = agentThreads
          .flatMap((thread): UnreadChatThread[] => {
            const unreadAt = unreadTimestamps.get(thread.id);
            return unreadAt === undefined ? [] : [{ ...thread, unreadAt }];
          })
          .sort(compareUnreadThreads);
      } else {
        matchingThreads = agentThreads;
      }
      const threads = matchingThreads.slice(0, limit);

      if (options.json) {
        console.log(
          JSON.stringify({
            ...(agentId === undefined ? { allAgents: true } : { agentId }),
            total: matchingThreads.length,
            threads,
          }),
        );
        return;
      }

      if (threads.length === 0) {
        console.log(
          chalk.dim(
            options.unread
              ? "No unread chat threads found"
              : "No chat threads found",
          ),
        );
        return;
      }

      const header = [
        "THREAD ID".padEnd(38),
        ...(options.allAgents ? ["AGENT ID".padEnd(38)] : []),
        ...(options.unread ? ["UNREAD AT".padEnd(20)] : []),
        "SORTED".padEnd(20),
        "PINNED".padEnd(6),
        "TITLE",
      ].join("  ");
      console.log(chalk.dim(header));
      for (const thread of threads) {
        console.log(
          [
            thread.id.padEnd(38),
            ...(options.allAgents ? [thread.agentId.padEnd(38)] : []),
            ...("unreadAt" in thread
              ? [formatIsoTimestamp(thread.unreadAt).padEnd(20)]
              : []),
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
