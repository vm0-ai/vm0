import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { VoiceChatCandidateTaskResultEntry } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyEventConsumer } from "../../../../../src/lib/infra/event-consumer";
import type { AgentEvent } from "../../../../../src/lib/infra/event-consumer/types";
import {
  appendTaskAssistantResult,
  markTaskRunningIfQueued,
} from "../../../../../src/lib/zero/voice-chat-candidate/task-service";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("event-consumer:voice-chat-candidate");

/**
 * Concatenate all text blocks in a single assistant event into one string.
 * Mirrors the chat-assistant consumer helper — kept inline per YAGNI until a
 * second caller needs it.
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
 * POST /api/internal/event-consumers/voice-chat-candidate
 *
 * Assistant-event consumer for voice-chat-candidate task runs.
 *  - First event seen for a queued task flips status → running (sets startedAt).
 *  - Assistant text blocks are appended to `tasks.result` (jsonb array).
 * Runs not tied to a VCC task are silently skipped.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyEventConsumer(request);
  if (!result.ok) {
    return result.response;
  }

  const { runId, events } = result.data;

  const now = new Date();
  const entries: VoiceChatCandidateTaskResultEntry[] = [];
  for (const event of events) {
    const text = eventText(event);
    if (text === null) continue;
    entries.push({
      type: "assistant",
      content: text,
      at: now.toISOString(),
    });
  }

  const running = await markTaskRunningIfQueued(runId);
  const appended =
    entries.length > 0
      ? await appendTaskAssistantResult({ runId, entries })
      : null;

  const touch = running ?? appended;
  if (touch) {
    await publishUserSignal(
      [touch.userId],
      `voice-chat-candidate:${touch.sessionId}`,
    );
  }

  log.debug("VCC assistant consumer processed", {
    runId,
    batch: entries.length,
    flipped: Boolean(running),
    appended: Boolean(appended),
  });

  return NextResponse.json({ processed: entries.length });
}
