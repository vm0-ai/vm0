import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { internalEventConsumerAgentPhoneTypingContract } from "@vm0/api-contracts/contracts/internal-event-consumers";

import {
  eventConsumerPayload$,
  eventConsumerRoute,
} from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import { optionalEnv } from "../../lib/env";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route";
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

async function sendAgentPhoneTypingIndicator(
  conversationId: string,
  signal: AbortSignal,
): Promise<void> {
  const apiBaseUrl = optionalEnv("AGENTPHONE_API_BASE_URL");
  const apiKey = optionalEnv("AGENTPHONE_API_KEY");
  if (!apiBaseUrl || !apiKey) {
    throw new Error("AgentPhone typing API is not configured");
  }

  const response = await fetch(
    `${apiBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/typing`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal,
    },
  );
  signal.throwIfAborted();

  if (!response.ok) {
    const body = await response.text();
    signal.throwIfAborted();
    throw new Error(`AgentPhone typing API error: ${response.status} ${body}`);
  }
}

const refreshAgentPhoneTypingForRun$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const callbacks = await db
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
    signal.throwIfAborted();

    const targets = new Map<string, AgentPhoneTypingTarget>();
    for (const callback of callbacks) {
      if (!callback.url.endsWith("/api/internal/callbacks/agentphone")) {
        continue;
      }

      const target = parseAgentPhoneTypingTarget(callback.payload);
      if (target) {
        targets.set(target.conversationId, target);
      }
    }

    for (const target of targets.values()) {
      await sendAgentPhoneTypingIndicator(target.conversationId, signal);
      signal.throwIfAborted();
    }
  },
);

const refreshInner$ = command(
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

export const internalEventConsumerAgentPhoneTypingRoutes: readonly RouteEntry[] =
  [
    {
      route: internalEventConsumerAgentPhoneTypingContract.refresh,
      handler: eventConsumerRoute(refreshInner$),
    },
  ];
