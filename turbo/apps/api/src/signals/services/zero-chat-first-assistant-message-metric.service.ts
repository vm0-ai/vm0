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

export function recordFirstAssistantMessageEligibility(args: {
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

async function recordFirstAssistantMessageAcknowledgement(args: {
  readonly db: Db;
  readonly runId: string;
  readonly acknowledgedAt: number;
}): Promise<void> {
  const [claimed] = await args.db
    .update(zeroRuns)
    .set({
      firstAssistantMessageAcknowledgedAt: new Date(args.acknowledgedAt),
    })
    .where(
      and(
        eq(zeroRuns.id, args.runId),
        isNotNull(zeroRuns.apiStartedAt),
        isNull(zeroRuns.firstAssistantMessageAcknowledgedAt),
      ),
    )
    .returning({
      apiStartedAt: zeroRuns.apiStartedAt,
    });
  if (!claimed?.apiStartedAt) {
    return;
  }

  const durationMs = elapsedSinceApiStartMs(
    claimed.apiStartedAt.getTime(),
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

export async function publishFirstAssistantMessageCreated(args: {
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
      recordFirstAssistantMessageAcknowledgement({
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
