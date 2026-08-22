import { command } from "ccstate";

import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { recordSameThreadRunnerJobPersisted } from "./runner-job-queue-lifecycle.service";
import { recordFirstAssistantEventEligibility } from "./chat-first-assistant-event-metric.service";
import { waitUntil } from "../context/wait-until";
import type { PendingRunActivation } from "./agent-run-activation.types";
import { dispatchConfiguredPiApiFirstTurn$ } from "./pi-api-first-turn-dispatch.service";

interface PendingRunActivationRequest {
  readonly activation: PendingRunActivation;
  readonly activationScheduledAt: number;
}

function startPiApiFirstTurn(
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  activation: NonNullable<PendingRunActivation["piApiFirstTurn"]>,
  deadlineAt: number,
): void {
  waitUntil(
    set(
      dispatchConfiguredPiApiFirstTurn$,
      activation,
      AbortSignal.timeout(Math.max(1, deadlineAt - now())),
    ),
  );
}

/** Common post-commit activation for direct and promoted pending runs. */
export const activatePendingRun$ = command(
  async ({ set }, input: PendingRunActivationRequest): Promise<void> => {
    const activationEnteredAt = now();
    const activation = input.activation;
    // Activation follows a durable run/job commit and therefore must finish
    // independently from the request that initiated that commit.
    if (activation.chatThreadId !== undefined) {
      recordSameThreadRunnerJobPersisted({
        runId: activation.runnerNotification.runId,
        createdAt: activation.runnerNotification.createdAt,
      });
      recordFirstAssistantEventEligibility({
        runId: activation.runnerNotification.runId,
        apiStartedAt: activation.apiStartTime,
      });
    }
    const sameThreadMarkersCompletedAt = now();

    const apiFirstTurn = activation.piApiFirstTurn;
    if (apiFirstTurn) {
      const deadlineAt =
        apiFirstTurn.executionContext.piLaunchConfig.apiFirstTurn.deadlineAt;
      startPiApiFirstTurn(set, apiFirstTurn, deadlineAt);
    }

    const db = set(writeDb$);
    const databaseReadyAt = now();
    await notifyRunnerJob(db, activation.runnerNotification, {
      preActivation: activation.timing,
      activationScheduledAt: input.activationScheduledAt,
      activationEnteredAt,
      sameThreadMarkersCompletedAt,
      databaseReadyAt,
      sameThreadMarkers:
        activation.chatThreadId === undefined ? "not_applicable" : "recorded",
    });
  },
);
