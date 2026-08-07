import { command } from "ccstate";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { tapError } from "../utils";
import type { PendingRunActivation } from "./agent-run-activation.service";
import { runPiEdgeTurn$ } from "./pi-edge-loop.service";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { recordSameThreadRunnerJobPersisted } from "./runner-job-queue-lifecycle.service";
import { recordFirstAssistantEventEligibility } from "./zero-chat-first-assistant-event-metric.service";

const L = logger("AgentRunActivation");

export const activatePendingRunInternal$ = command(
  async (
    { set },
    input: PendingRunActivation,
    signal: AbortSignal,
  ): Promise<void> => {
    if (input.chatThreadId !== undefined) {
      recordSameThreadRunnerJobPersisted({
        runId: input.runnerNotification.runId,
        createdAt: input.runnerNotification.createdAt,
      });
      recordFirstAssistantEventEligibility({
        runId: input.runnerNotification.runId,
        apiStartedAt: input.apiStartTime,
      });
    }

    if (input.piEdgeTurn !== undefined) {
      waitUntil(
        tapError(set(runPiEdgeTurn$, input.piEdgeTurn, signal), (error) => {
          L.error("Pi edge turn dispatch failed", {
            runId: input.piEdgeTurn?.runId,
            error,
          });
        }),
      );
    }

    const db = set(writeDb$);
    await notifyRunnerJob(db, input.runnerNotification);
  },
);
