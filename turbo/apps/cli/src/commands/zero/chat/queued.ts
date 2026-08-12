import chalk from "chalk";
import { Command } from "commander";

import { listZeroQueuedChatEvents } from "../../../lib/api/domains/zero-chat";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { resolveChatThreadId } from "./shared";

interface QueuedOptions {
  readonly json?: boolean;
  readonly threadId?: string;
}

export const queuedCommand = new Command()
  .name("queued")
  .description("List events waiting in a web chat thread queue")
  .option(
    "--thread-id <id>",
    "Chat thread ID (defaults to OKOU_CHAT_THREAD_ID)",
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Show this queue:    okou chat queued
  Show another queue: okou chat queued --thread-id <thread-id>
  Print JSON:         okou chat queued --thread-id <thread-id> --json

Notes:
  - Lists authoritative queued event IDs and sequence IDs
  - Event IDs can be passed to okou chat cancel --event-id
  - Authenticates via OKOU_TOKEN (requires chat-event:read capability)`,
  )
  .action(
    withErrorHandler(async (options: QueuedOptions) => {
      const threadId = resolveChatThreadId(options.threadId);
      const queued = await listZeroQueuedChatEvents({ threadId });
      if (options.json) {
        console.log(JSON.stringify({ threadId, total: queued.length, queued }));
        return;
      }
      if (queued.length === 0) {
        console.log(chalk.dim("No queued chat events"));
        return;
      }

      console.log(chalk.dim(["EVENT ID".padEnd(38), "SEQ ID"].join("  ")));
      for (const event of queued) {
        console.log([event.eventId.padEnd(38), String(event.seqId)].join("  "));
      }
      console.log();
      console.log(chalk.dim("Sync and inspect raw chat history:"));
      console.log(
        `  okou chat messages --thread-id ${threadId} --output-dir threads`,
      );
      for (const event of queued) {
        console.log(`  rg -n '"seqId":${event.seqId}' threads/${threadId}/`);
      }
    }),
  );
