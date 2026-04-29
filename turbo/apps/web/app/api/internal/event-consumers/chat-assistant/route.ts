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

function anthropicMessageText(event: AgentEvent): string | null {
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

function codexAgentMessageText(event: AgentEvent): string | null {
  if (event.type !== "item.completed") return null;
  const item = event.item;
  if (
    typeof item !== "object" ||
    item === null ||
    !("type" in item) ||
    item.type !== "agent_message" ||
    !("text" in item) ||
    typeof item.text !== "string" ||
    item.text.length === 0
  ) {
    return null;
  }
  return item.text;
}

/**
 * Extract user-facing assistant text from a single agent event. Two shapes
 * are supported: Anthropic `assistant` events with `message.content[]` text
 * blocks, and codex `item.completed` events whose item is an `agent_message`.
 * Tool-call / command / reasoning items return null — activity summaries are
 * rendered live from the telemetry endpoint, not chat persistence.
 */
function eventText(event: AgentEvent): string | null {
  const fromMessage = anthropicMessageText(event);
  if (fromMessage !== null) return fromMessage;
  return codexAgentMessageText(event);
}

/**
 * Extract the upstream message ID from an event for run_event_id dedup.
 * Anthropic events expose `message.id` (e.g. "msg_01abc..."); codex
 * `item.completed` events expose `item.id` (e.g. "item_1").
 */
function eventMessageId(event: AgentEvent): string | undefined {
  const msg = event.message;
  if (typeof msg === "object" && msg !== null && "id" in msg) {
    const id = (msg as { id: unknown }).id;
    if (typeof id === "string") return id;
  }

  const item = event.item;
  if (typeof item === "object" && item !== null && "id" in item) {
    const id = (item as { id: unknown }).id;
    if (typeof id === "string") return id;
  }

  return undefined;
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

  const items: {
    sequenceNumber: number;
    content: string;
    runEventId?: string;
  }[] = [];
  for (const event of events) {
    const text = eventText(event);
    if (text === null) continue;
    items.push({
      sequenceNumber: event.sequenceNumber,
      content: text,
      runEventId: eventMessageId(event),
    });
  }

  if (items.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const thread = await getChatThreadIdForRun(runId);
  if (!thread) {
    // Run is not tied to a chat thread (e.g., non-chat trigger) — skip.
    return NextResponse.json({ processed: 0 });
  }

  const { chatThreadId: threadId, userId } = thread;
  const written = await insertAssistantEventMessages(
    runId,
    threadId,
    userId,
    items,
  );

  log.debug("Chat assistant consumer processed", {
    runId,
    batch: items.length,
    written,
  });

  return NextResponse.json({ processed: written });
}
