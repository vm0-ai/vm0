import chalk from "chalk";
import { Command } from "commander";
import { foldPendingChatQueueEvents } from "@vm0/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";

import {
  isZeroChatEventSnapshotReadEnabled,
  listZeroChatEvents,
  listZeroQueuedChatEvents,
} from "../../../lib/api/domains/zero-chat";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { formatIsoTimestamp } from "../../../lib/utils/time-format";
import { resolveChatThreadId } from "./shared";

const PAGE_LIMIT = 50;

/** Per-thread chat event sequences start at 1, so this marks the oldest event. */
const FIRST_CHAT_EVENT_SEQ_ID = 1;

interface QueuedOptions {
  readonly json?: boolean;
  readonly threadId?: string;
}

interface QueuedEventSummary {
  readonly eventId: string;
  readonly eventType: "input.prompt" | "input.automation";
  readonly createdAt: string;
  readonly text: string;
}

async function loadAllChatEvents(threadId: string): Promise<ChatEvent[]> {
  let beforeSeqId: number | undefined;
  const newestFirstPages: ChatEvent[][] = [];

  for (;;) {
    const events = await listZeroChatEvents({
      threadId,
      beforeSeqId,
      limit: PAGE_LIMIT,
    });
    newestFirstPages.push([...events]);

    // A thread's first event always carries seqId 1, so reaching it is the only
    // stop condition. The cursor strictly decreases, so the walk terminates.
    const oldestInPage = events[0];
    if (
      oldestInPage === undefined ||
      oldestInPage.seqId <= FIRST_CHAT_EVENT_SEQ_ID
    ) {
      return newestFirstPages.reverse().flat();
    }
    beforeSeqId = oldestInPage.seqId;
  }
}

function compactText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function summarizeQueuedEvent(event: ChatEvent): QueuedEventSummary | null {
  if (event.eventType === "input.prompt") {
    return {
      eventId: event.id,
      eventType: event.eventType,
      createdAt: event.createdAt,
      text: compactText(event.content),
    };
  }
  if (event.eventType === "input.automation") {
    const automationPart = event.userMessage?.parts.find((part) => {
      return part.type === "automation";
    });
    return {
      eventId: event.id,
      eventType: event.eventType,
      createdAt: event.createdAt,
      text: compactText(
        automationPart?.type === "automation"
          ? (automationPart.automationBrief ?? automationPart.workflowName)
          : undefined,
      ),
    };
  }
  return null;
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
  - With snapshot read enabled, lists authoritative queued event IDs and sequence IDs
  - Otherwise lists the same unassociated user and automation events shown by Platform
  - Event IDs can be passed to okou chat cancel --event-id
  - Authenticates via OKOU_TOKEN (requires chat-event:read capability)`,
  )
  .action(
    withErrorHandler(async (options: QueuedOptions) => {
      const threadId = resolveChatThreadId(options.threadId);
      if (await isZeroChatEventSnapshotReadEnabled()) {
        const queued = await listZeroQueuedChatEvents({ threadId });
        if (options.json) {
          console.log(
            JSON.stringify({ threadId, total: queued.length, queued }),
          );
          return;
        }
        if (queued.length === 0) {
          console.log(chalk.dim("No queued chat events"));
          return;
        }

        console.log(chalk.dim(["EVENT ID".padEnd(38), "SEQ ID"].join("  ")));
        for (const event of queued) {
          console.log(
            [event.eventId.padEnd(38), String(event.seqId)].join("  "),
          );
        }
        console.log();
        console.log(chalk.dim("Sync and inspect raw chat history:"));
        console.log(
          `  okou chat messages --thread-id ${threadId} --output-dir threads`,
        );
        for (const event of queued) {
          console.log(`  rg -n '"seqId":${event.seqId}' threads/${threadId}/`);
        }
        return;
      }

      const allEvents = await loadAllChatEvents(threadId);
      const queued = foldPendingChatQueueEvents(allEvents).flatMap((event) => {
        const summary = summarizeQueuedEvent(event);
        return summary ? [summary] : [];
      });

      if (options.json) {
        console.log(JSON.stringify({ threadId, total: queued.length, queued }));
        return;
      }

      if (queued.length === 0) {
        console.log(chalk.dim("No queued chat events"));
        return;
      }

      console.log(
        chalk.dim(
          [
            "EVENT ID".padEnd(38),
            "TYPE".padEnd(18),
            "QUEUED".padEnd(20),
            "MESSAGE",
          ].join("  "),
        ),
      );
      for (const event of queued) {
        console.log(
          [
            event.eventId.padEnd(38),
            event.eventType.padEnd(18),
            formatIsoTimestamp(event.createdAt).padEnd(20),
            event.text || "(no message text)",
          ].join("  "),
        );
      }
    }),
  );
