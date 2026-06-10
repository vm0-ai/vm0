import { automations, automationTriggers } from "@vm0/db/schema/automation";
import type { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { eq } from "drizzle-orm";

import { logger } from "../../../lib/log";
import type { Db } from "../../external/db";
import { tapError } from "../../utils";

const log = logger("api:automations:schedule-dual-write");

/** Interpreter key persisted for schedule-mirrored automations. */
const TIME_INTERPRETER_KIND = "time";

/**
 * Postgres unique-constraint violation (SQLSTATE 23505). The known collision:
 * `idx_automations_agent_name_org_user` when a schedule shares its name with a
 * natively-created (e.g. webhook) automation on the same agent.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

type ScheduleRow = typeof zeroAgentSchedules.$inferSelect;

/**
 * The `automations` columns a schedule mirror writes. Derived entirely from the
 * source `zero_agent_schedules` row; `sourceScheduleId` keys the mirror for
 * idempotency (the table's `idx_automations_source_schedule` unique index).
 */
function automationValuesFromSchedule(schedule: ScheduleRow): {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string | null;
  readonly instruction: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly interpreterKind: string;
  readonly enabled: boolean;
  readonly sourceScheduleId: string;
  readonly updatedAt: Date;
} {
  return {
    orgId: schedule.orgId,
    userId: schedule.userId,
    name: schedule.name,
    description: schedule.description,
    // The interpreter renders the automation's `instruction`; for a mirrored
    // schedule that instruction is the schedule prompt.
    instruction: schedule.prompt,
    agentId: schedule.agentId,
    chatThreadId: schedule.chatThreadId,
    interpreterKind: TIME_INTERPRETER_KIND,
    enabled: schedule.enabled,
    sourceScheduleId: schedule.id,
    updatedAt: schedule.updatedAt,
  };
}

/**
 * The time-`automation_triggers` columns a schedule mirror writes: the trigger
 * kind + config (cron/once/loop, mutually exclusive) and the full runtime state
 * carried over verbatim from the source schedule so the (dormant) trigger poller
 * sees an exact mirror. This is data-sync only — it never creates a run.
 */
function triggerValuesFromSchedule(
  schedule: ScheduleRow,
  automationId: string,
): {
  readonly automationId: string;
  readonly kind: string;
  readonly cronExpression: string | null;
  readonly atTime: Date | null;
  readonly intervalSeconds: number | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastRunId: string | null;
  readonly consecutiveFailures: number;
  readonly retryStartedAt: Date | null;
  readonly enabled: boolean;
  readonly updatedAt: Date;
} {
  return {
    automationId,
    kind: schedule.triggerType,
    cronExpression: schedule.cronExpression,
    atTime: schedule.atTime,
    intervalSeconds: schedule.intervalSeconds,
    timezone: schedule.timezone,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastRunId: schedule.lastRunId,
    consecutiveFailures: schedule.consecutiveFailures,
    retryStartedAt: schedule.retryStartedAt,
    enabled: schedule.enabled,
    updatedAt: schedule.updatedAt,
  };
}

/**
 * Mirror a `zero_agent_schedules` row into the events-first tables: upsert the
 * `automations` row keyed on `sourceScheduleId` and its single time
 * `automation_triggers` row keyed on `automationId`. Idempotent — re-running for
 * the same schedule updates the existing mirror in place rather than duplicating
 * it. Pure data-sync: it carries over enabled state + runtime fields
 * (`nextRunAt`/`lastRunAt`/`lastRunId`/`consecutiveFailures`/`retryStartedAt`)
 * but NEVER creates a run (the live `executeDueSchedules$` poller remains the
 * only schedule executor; the trigger poller is dormant).
 */
async function syncScheduleToAutomation(
  db: Db,
  schedule: ScheduleRow,
): Promise<void> {
  const [existing] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(eq(automations.sourceScheduleId, schedule.id))
    .limit(1);

  const automationValues = automationValuesFromSchedule(schedule);

  if (existing) {
    await db
      .update(automations)
      .set(automationValues)
      .where(eq(automations.id, existing.id));
    await db
      .update(automationTriggers)
      .set(triggerValuesFromSchedule(schedule, existing.id))
      .where(eq(automationTriggers.automationId, existing.id));
    return;
  }

  const [created] = await db
    .insert(automations)
    .values(automationValues)
    .returning({ id: automations.id });
  if (!created) {
    throw new Error(
      `syncScheduleToAutomation: automation insert returned no row for schedule ${schedule.id}`,
    );
  }
  await db
    .insert(automationTriggers)
    .values(triggerValuesFromSchedule(schedule, created.id));
}

/**
 * Best-effort `syncScheduleToAutomation`: the mirror is a transition aid, so a
 * mirror-write failure must never fail the user's schedule operation — the
 * primary `zero_agent_schedules` write has already committed by the time this
 * runs. Failures are logged (with a `uniqueConflict` flag for the known
 * agent+name+org+user collision with natively-created automations) and
 * swallowed; aborts still propagate.
 */
export async function syncScheduleToAutomationSafely(
  db: Db,
  schedule: ScheduleRow,
): Promise<void> {
  await tapError(syncScheduleToAutomation(db, schedule), (error) => {
    log.error("Schedule mirror sync failed; schedule operation unaffected", {
      scheduleId: schedule.id,
      agentId: schedule.agentId,
      scheduleName: schedule.name,
      uniqueConflict: isUniqueViolation(error),
      error,
    });
  });
}

/**
 * Remove the events-first mirror of a schedule: delete the `automations` row
 * keyed on `sourceScheduleId` (its time trigger row is removed by the FK
 * cascade). Idempotent — a no-op when no mirror exists. Counterpart to
 * `syncScheduleToAutomation` for the schedule-delete path.
 */
async function deleteScheduleAutomation(
  db: Db,
  scheduleId: string,
): Promise<void> {
  await db
    .delete(automations)
    .where(eq(automations.sourceScheduleId, scheduleId));
}

/**
 * Best-effort `deleteScheduleAutomation`: same contract as
 * `syncScheduleToAutomationSafely` — a mirror-delete failure must never fail
 * the user's schedule delete. Failures are logged and swallowed; aborts still
 * propagate.
 */
export async function deleteScheduleAutomationSafely(
  db: Db,
  scheduleId: string,
): Promise<void> {
  await tapError(deleteScheduleAutomation(db, scheduleId), (error) => {
    log.error("Schedule mirror delete failed; schedule delete unaffected", {
      scheduleId,
      error,
    });
  });
}
