import { elapsedSinceApiStartMs } from "@vm0/api-contracts/contracts/runners";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now } from "../external/time";
import { tapError } from "../utils";

const L = logger("api:zero:chat-first-assistant-message-metric");

export function recordFirstAssistantEventEligibility(args: {
  readonly runId: string;
  readonly apiStartedAt: number;
}): void {
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "first_assistant_message_eligible",
    durationMs: 0,
    success: true,
    runId: args.runId,
    timestamp: new Date(args.apiStartedAt).toISOString(),
  });
}

async function recordFirstAssistantEventAcknowledgement(args: {
  readonly db: Db;
  readonly runId: string;
  readonly acknowledgedAt: number;
}): Promise<void> {
  const [claimed] = await args.db
    .update(zeroRuns)
    .set({
      firstAssistantEventAcknowledgedAt: new Date(args.acknowledgedAt),
    })
    .where(
      and(
        eq(zeroRuns.id, args.runId),
        isNotNull(zeroRuns.apiStartedAt),
        isNull(zeroRuns.firstAssistantEventAcknowledgedAt),
      ),
    )
    .returning({
      apiStartedAt: zeroRuns.apiStartedAt,
    });
  if (!claimed?.apiStartedAt) {
    return;
  }

  recordFirstAssistantEventAcknowledgementMetric({
    runId: args.runId,
    apiStartedAt: claimed.apiStartedAt.getTime(),
    acknowledgedAt: args.acknowledgedAt,
  });
}

export function recordFirstAssistantEventAcknowledgementMetric(args: {
  readonly runId: string;
  readonly apiStartedAt: number;
  readonly acknowledgedAt: number;
}): void {
  const durationMs = elapsedSinceApiStartMs(
    args.apiStartedAt,
    args.acknowledgedAt,
  );
  if (durationMs === undefined) {
    return;
  }

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "api_to_first_assistant_message",
    durationMs,
    success: true,
    runId: args.runId,
    timestamp: new Date(args.acknowledgedAt).toISOString(),
  });
}

export async function publishFirstAssistantEventCreatedSignalSafely(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<void> {
  await tapError(
    publishUserSignal(
      [args.userId],
      `chatThreadMessageCreated:${args.threadId}`,
    ),
    (error) => {
      L.warn("Failed to publish first assistant message created signal", {
        runId: args.runId,
        threadId: args.threadId,
        error,
      });
    },
  );
}

async function publishFirstAssistantEventCreated(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<void> {
  await publishUserSignal(
    [args.userId],
    `chatThreadMessageCreated:${args.threadId}`,
  );
  const acknowledgedAt = now();
  waitUntil(
    tapError(
      recordFirstAssistantEventAcknowledgement({
        db: args.db,
        runId: args.runId,
        acknowledgedAt,
      }),
      (error) => {
        L.warn("Failed to record first assistant message acknowledgement", {
          runId: args.runId,
          error,
        });
      },
    ),
  );
}

export async function publishFirstAssistantEventCreatedSafely(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<void> {
  await tapError(publishFirstAssistantEventCreated(args), (error) => {
    L.warn("Failed to publish first assistant message created signal", {
      runId: args.runId,
      threadId: args.threadId,
      error,
    });
  });
}
