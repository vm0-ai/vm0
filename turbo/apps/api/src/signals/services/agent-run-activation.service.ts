import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import {
  notifyRunnerJob,
  type RunnerJobNotification,
} from "./runner-dispatch.service";
import { recordSameThreadRunnerJobPersisted } from "./runner-job-queue-lifecycle.service";
import { recordFirstAssistantEventEligibility } from "./zero-chat-first-assistant-event-metric.service";

export interface PendingRunActivation {
  readonly apiStartTime: number;
  readonly chatThreadId: string | undefined;
  readonly runnerNotification: RunnerJobNotification;
}

/** Common post-commit activation for direct and promoted pending runs. */
export const activatePendingRun$ = command(
  async ({ set }, input: PendingRunActivation): Promise<void> => {
    // Activation follows a durable run/job commit and therefore must finish
    // independently from the request that initiated that commit.
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

    const db = set(writeDb$);
    await notifyRunnerJob(db, input.runnerNotification);
  },
);
