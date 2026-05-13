import { command } from "ccstate";
import {
  internalCallbacksScheduleContract,
  scheduleCronCallbackPayloadSchema,
  scheduleLoopCallbackPayloadSchema,
  type ScheduleCronCallbackPayload,
  type ScheduleLoopCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-schedule";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { getRunOutputText } from "../services/run-output.service";
import { calculateNextRun } from "../services/zero-schedules.service";
import { saveRunSummary$ } from "../services/run-summary.service";
import { safeAsync } from "../utils";

const MAX_CONSECUTIVE_FAILURES = 3;

type ScheduleRow = typeof zeroAgentSchedules.$inferSelect;
type SchedulePayload =
  | { readonly kind: "cron"; readonly data: ScheduleCronCallbackPayload }
  | { readonly kind: "loop"; readonly data: ScheduleLoopCallbackPayload };

function successResponse(skipped?: true): {
  readonly status: 200;
  readonly body: { readonly success: true; readonly skipped?: true };
} {
  return { status: 200, body: { success: true, ...(skipped && { skipped }) } };
}

function errorResponse(message: string): {
  readonly status: 400;
  readonly body: { readonly error: string };
} {
  return { status: 400, body: { error: message } };
}

function parseCronPayload(payload: unknown): SchedulePayload | null {
  const result = scheduleCronCallbackPayloadSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }
  return { kind: "cron", data: result.data };
}

function parseLoopPayload(payload: unknown): SchedulePayload | null {
  const result = scheduleLoopCallbackPayloadSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }
  return { kind: "loop", data: result.data };
}

function nextRunAtForSchedule(
  payload: SchedulePayload,
  schedule: ScheduleRow,
  completedAt: Date,
): Date | null {
  if (payload.kind === "cron") {
    return payload.data.cronExpression
      ? calculateNextRun(payload.data.cronExpression, schedule.timezone)
      : null;
  }

  if (schedule.intervalSeconds === null) {
    throw new Error("Loop schedule is missing intervalSeconds");
  }
  return new Date(completedAt.getTime() + schedule.intervalSeconds * 1000);
}

async function getBestEffortRunOutputText(
  runId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await safeAsync(() => {
    return getRunOutputText(runId, { waitForOutput: false, signal });
  });
  signal.throwIfAborted();
  return "ok" in result ? result.ok : undefined;
}

function createScheduleCallbackHandler(
  parsePayload: (payload: unknown) => SchedulePayload | null,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = parsePayload(callback.payload);
    if (!payload) {
      return errorResponse("Invalid or missing payload");
    }

    if (callback.status === "progress") {
      return successResponse(true);
    }

    const writeDb = set(writeDb$);
    const [schedule] = await writeDb
      .select()
      .from(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.id, payload.data.scheduleId))
      .limit(1);
    signal.throwIfAborted();

    if (!schedule || !schedule.enabled) {
      return successResponse(true);
    }

    const completedAt = nowDate();
    const consecutiveFailures =
      callback.status === "completed" ? 0 : schedule.consecutiveFailures + 1;
    const shouldDisable = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    const nextRunAt = shouldDisable
      ? null
      : nextRunAtForSchedule(payload, schedule, completedAt);

    await writeDb
      .update(zeroAgentSchedules)
      .set({
        consecutiveFailures,
        ...(shouldDisable && { enabled: false }),
        nextRunAt,
        updatedAt: completedAt,
      })
      .where(eq(zeroAgentSchedules.id, payload.data.scheduleId));
    signal.throwIfAborted();

    if (callback.status === "completed" && schedule.prompt) {
      const resultText = await getBestEffortRunOutputText(
        callback.runId,
        signal,
      );
      await set(
        saveRunSummary$,
        {
          runId: callback.runId,
          triggerSource: "schedule",
          prompt: schedule.prompt,
          resultText: resultText ?? "",
        },
        signal,
      );
      signal.throwIfAborted();
    }

    return successResponse();
  });
}

const handleCronScheduleCallback$ =
  createScheduleCallbackHandler(parseCronPayload);
const handleLoopScheduleCallback$ =
  createScheduleCallbackHandler(parseLoopPayload);

export const internalCallbacksScheduleRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksScheduleContract.cron,
    handler: callbackRoute(handleCronScheduleCallback$),
  },
  {
    route: internalCallbacksScheduleContract.loop,
    handler: callbackRoute(handleLoopScheduleCallback$),
  },
];
