import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";

import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { sendAgentPhoneTypingIndicator } from "../external/agentphone-client";
import { db$ } from "../external/db";
import { internalRunCallbackKindForRecord } from "../services/internal-run-callback";
import { tapError } from "../utils";

const L = logger("event-consumer:agentphone-typing");

interface AgentPhoneTypingTarget {
  readonly conversationId: string;
}

function parseAgentPhoneTypingTarget(
  payload: unknown,
): AgentPhoneTypingTarget | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const data = payload as Record<string, unknown>;
  if (
    data.channel !== "imessage" ||
    typeof data.conversationId !== "string" ||
    data.conversationId.length === 0
  ) {
    return undefined;
  }

  return { conversationId: data.conversationId };
}

const refreshAgentPhoneTypingForRun$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const callbacks = await db
      .select({
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
        ),
      );
    signal.throwIfAborted();

    const targets = new Map<string, AgentPhoneTypingTarget>();
    for (const callback of callbacks) {
      if (internalRunCallbackKindForRecord(callback) !== "agentphone") {
        continue;
      }

      const target = parseAgentPhoneTypingTarget(callback.payload);
      if (target) {
        targets.set(target.conversationId, target);
      }
    }

    for (const target of targets.values()) {
      await sendAgentPhoneTypingIndicator(
        { conversationId: target.conversationId },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);

export const refreshAgentPhoneTypingEvents$ = command(
  ({ get, set }, signal: AbortSignal): RefreshResponse => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();

    waitUntil(
      tapError(
        set(refreshAgentPhoneTypingForRun$, payload.runId, signal),
        (error) => {
          L.debug("Failed to refresh AgentPhone typing from events", {
            runId: payload.runId,
            batch: payload.events.length,
            error,
          });
        },
      ),
    );

    return { status: 200, body: { scheduled: true } };
  },
);

interface RefreshResponse {
  readonly status: 200;
  readonly body: { readonly scheduled: true };
}
