import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyEventConsumer } from "../../../../../src/lib/infra/event-consumer";
import type { AgentEvent } from "../../../../../src/lib/infra/event-consumer/types";
import {
  insertAssistantEventMessages,
  getChatThreadIdForRun,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("event-consumer:chat-assistant");

/**
 * Concatenate all text blocks in a single assistant event into one string.
 * Assistant events usually carry a single text block, but may carry several
 * interleaved with tool_use blocks. Tool_use blocks are ignored here —
 * activity summaries are rendered live from the telemetry endpoint.
 */
function eventText(event: AgentEvent): string | null {
  const msg = event.message;
  if (
    typeof msg !== "object" ||
    msg === null ||
    !("content" in msg) ||
    !Array.isArray(msg.content)
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const block of msg.content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

/**
 * POST /api/internal/event-consumers/chat-assistant
 *
 * Handles "assistant" events for chat threads. For each event, inserts a
 * single chat_messages row keyed by `(run_id, sequence_number)` via
 * `ON CONFLICT DO NOTHING`. No lock, no Axiom re-query.
 *
 * Runs that are not tied to a chat thread (no assistant placeholder) are
 * silently skipped.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyEventConsumer(request);
  if (!result.ok) {
    return result.response;
  }

  const { runId, events } = result.data;

  const items: { sequenceNumber: number; content: string }[] = [];
  for (const event of events) {
    const text = eventText(event);
    if (text === null) continue;
    items.push({ sequenceNumber: event.sequenceNumber, content: text });
  }

  if (items.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const threadId = await getChatThreadIdForRun(runId);
  if (!threadId) {
    // Run is not tied to a chat thread (e.g., non-chat trigger) — skip.
    return NextResponse.json({ processed: 0 });
  }

  const written = await insertAssistantEventMessages(runId, threadId, items);

  log.debug("Chat assistant consumer processed", {
    runId,
    batch: items.length,
    written,
  });

  return NextResponse.json({ processed: written });
}
