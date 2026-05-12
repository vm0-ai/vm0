import { after, NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyEventConsumer } from "../../../../../src/lib/infra/event-consumer";
import { sendAgentPhoneTypingIndicator } from "../../../../../src/lib/zero/agentphone/client";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("event-consumer:agentphone-typing");

interface AgentPhoneTypingTarget {
  conversationId: string;
}

function parseAgentPhoneTypingTarget(
  payload: unknown,
): AgentPhoneTypingTarget | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  const data = payload as Record<string, unknown>;
  if (
    data.channel !== "imessage" ||
    typeof data.conversationId !== "string" ||
    !data.conversationId
  ) {
    return undefined;
  }

  return { conversationId: data.conversationId };
}

async function refreshAgentPhoneTypingForRun(runId: string): Promise<number> {
  const callbacks = await globalThis.services.db
    .select({
      url: agentRunCallbacks.url,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.status, "pending"),
      ),
    );

  const targets = new Map<string, AgentPhoneTypingTarget>();
  for (const callback of callbacks) {
    if (!callback.url.endsWith("/api/internal/callbacks/agentphone")) {
      continue;
    }

    const target = parseAgentPhoneTypingTarget(callback.payload);
    if (target) targets.set(target.conversationId, target);
  }

  let refreshed = 0;
  for (const target of targets.values()) {
    await sendAgentPhoneTypingIndicator({
      conversationId: target.conversationId,
    });
    refreshed++;
  }

  return refreshed;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyEventConsumer(request);
  if (!result.ok) {
    return result.response;
  }

  const { runId, events } = result.data;

  after(() => {
    return refreshAgentPhoneTypingForRun(runId).catch((error) => {
      log.debug("Failed to refresh AgentPhone typing from events", {
        runId,
        batch: events.length,
        error,
      });
    });
  });

  return NextResponse.json({ scheduled: true });
}
