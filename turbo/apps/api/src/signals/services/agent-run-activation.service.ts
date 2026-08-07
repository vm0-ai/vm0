import { command } from "ccstate";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { tapError } from "../utils";
import type { PiEdgeTurnArgs } from "./pi-edge-config";
import { dispatchConfiguredPiEdgeTurn$ } from "./pi-edge-turn-dispatch.service";
import {
  notifyRunnerJob,
  type RunnerJobNotification,
} from "./runner-dispatch.service";
import { recordSameThreadRunnerJobPersisted } from "./runner-job-queue-lifecycle.service";
import { recordFirstAssistantEventEligibility } from "./zero-chat-first-assistant-event-metric.service";

const L = logger("AgentRunActivation");

export interface PendingRunActivation {
  readonly apiStartTime: number;
  readonly chatThreadId: string | undefined;
  readonly piEdgeTurn: PiEdgeTurnArgs | undefined;
  readonly runnerNotification: RunnerJobNotification;
}

/** Common post-commit activation for direct and promoted pending runs. */
export const activatePendingRun$ = command(
  async ({ set }, input: PendingRunActivation): Promise<void> => {
    // Activation follows a durable run/job commit and therefore must finish
    // independently from the request that initiated that commit.
    const commitSignal = new AbortController().signal;

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
        tapError(
          set(dispatchConfiguredPiEdgeTurn$, input.piEdgeTurn, commitSignal),
          (error) => {
            L.error("Pi edge turn dispatch failed", {
              runId: input.piEdgeTurn?.runId,
              error,
            });
          },
        ),
      );
    }

    const db = set(writeDb$);
    await notifyRunnerJob(db, input.runnerNotification);
  },
);
