import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { createStore } from "ccstate";
import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../../__tests__/test-helpers";
import { writeDb$ } from "../../../external/db";
import {
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
  type SchedulesFixture,
} from "../../../routes/__tests__/helpers/zero-schedules";
import { createFixtureTracker } from "../../../routes/__tests__/helpers/zero-route-test";

const context = testContext();
const store = createStore();

// The one-time, idempotent backfill data migration under test. The replay
// strips retry_started_at references: the column is vestigial (no production
// writer since the runtime mirror-sync landed) and is dropped together with
// the refresh-backfill migration, so the historical SQL must run without it.
const BACKFILL_SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../../../packages/db/src/migrations/0442_backfill_schedules_to_automations.sql",
      import.meta.url,
    ),
  ),
  "utf8",
)
  .replaceAll('  "retry_started_at",\n', "")
  .replaceAll('  "schedule"."retry_started_at",\n', "");

// The refresh migration: its DROP COLUMN DDL already ran via db:migrate, so
// slice it off and keep only the data statements (mapped-mirror re-sync +
// unmapped insert), which are fully re-runnable.
const REFRESH_SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../../../packages/db/src/migrations/0448_moaning_rattler.sql",
      import.meta.url,
    ),
  ),
  "utf8",
)
  .split("--> statement-breakpoint")
  .slice(1)
  .join("--> statement-breakpoint");

// 0444 adds automations.append_system_prompt and carries it into mirrors that
// predate the column. The DDL already ran via db:migrate; only the data UPDATE
// (everything after the first statement-breakpoint) is re-runnable here.
const APPEND_PROMPT_CARRY_SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../../../packages/db/src/migrations/0444_nebulous_rockslide.sql",
      import.meta.url,
    ),
  ),
  "utf8",
)
  .split("--> statement-breakpoint")
  .slice(1)
  .join(";");

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

// The replayed migrations are global data migrations (prod runs them exactly
// once); scope them to the fixture org here so parallel test files seeding
// their own schedules/mirrors can never interfere with a replay.
function scopeToOrg(rawSql: string, orgId: string): string {
  return rawSql
    .replaceAll(
      `FROM "zero_agent_schedules" AS "schedule"
  WHERE NOT EXISTS (`,
      `FROM "zero_agent_schedules" AS "schedule"
  WHERE "schedule"."org_id" = '${orgId}' AND NOT EXISTS (`,
    )
    .replaceAll(
      `WHERE "automation"."source_schedule_id" = "schedule"."id";`,
      `WHERE "automation"."source_schedule_id" = "schedule"."id" AND "schedule"."org_id" = '${orgId}';`,
    )
    .replaceAll(
      `WHERE "trigger"."automation_id" = "automation"."id";`,
      `WHERE "trigger"."automation_id" = "automation"."id" AND "schedule"."org_id" = '${orgId}';`,
    );
}

async function runBackfill(orgId: string): Promise<void> {
  const db = store.set(writeDb$);
  await db.execute(sql.raw(scopeToOrg(BACKFILL_SQL, orgId)));
}

async function runAppendPromptCarry(): Promise<void> {
  const db = store.set(writeDb$);
  await db.execute(sql.raw(APPEND_PROMPT_CARRY_SQL));
}

async function runRefresh(orgId: string): Promise<void> {
  const db = store.set(writeDb$);
  // Drizzle's statement-breakpoint marker is a migration-runner construct;
  // execute the statements individually here.
  const scoped = scopeToOrg(REFRESH_SQL, orgId);
  for (const statement of scoped.split("--> statement-breakpoint")) {
    await db.execute(sql.raw(statement));
  }
}

async function mirrorsForSchedules(
  scheduleIds: readonly string[],
): Promise<(typeof automations.$inferSelect)[]> {
  const db = store.set(writeDb$);
  if (scheduleIds.length === 0) {
    return [];
  }
  return await db
    .select()
    .from(automations)
    .where(inArray(automations.sourceScheduleId, [...scheduleIds]));
}

describe("backfill schedules into events-first tables", () => {
  let fixture: SchedulesFixture;

  beforeEach(async () => {
    // Seed two schedules directly (no dual-write), so the backfill has unmapped
    // rows to copy. One cron + enabled, one loop + disabled — covering kind and
    // enabled-state carry-over.
    fixture = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "cron-existing",
              cronExpression: "0 9 * * *",
              prompt: "Existing cron prompt",
              description: "cron desc",
              appendSystemPrompt: "Existing cron append prompt",
              enabled: true,
              nextRunAt: new Date("2099-01-01T09:00:00.000Z"),
              consecutiveFailures: 1,
            },
            {
              name: "loop-existing",
              intervalSeconds: 1800,
              prompt: "Existing loop prompt",
              enabled: false,
              nextRunAt: null,
            },
          ],
        },
        context.signal,
      ),
    );
  });

  it("copies every existing schedule into automations + a time trigger", async () => {
    // Precondition: nothing mirrored yet.
    await expect(
      mirrorsForSchedules(fixture.scheduleIds),
    ).resolves.toHaveLength(0);

    await runBackfill(fixture.orgId);

    const mirrors = await mirrorsForSchedules(fixture.scheduleIds);
    expect(mirrors).toHaveLength(2);

    const db = store.set(writeDb$);
    const bySource = new Map(
      mirrors.map((row) => {
        return [row.sourceScheduleId, row] as const;
      }),
    );

    const [cronId, loopId] = fixture.scheduleIds;
    const cronAutomation = cronId ? bySource.get(cronId) : undefined;
    const loopAutomation = loopId ? bySource.get(loopId) : undefined;
    expect(cronAutomation).toBeDefined();
    expect(loopAutomation).toBeDefined();
    if (!cronAutomation || !loopAutomation) {
      return;
    }

    // Automation carries identity + instruction + enabled state from the source.
    expect(cronAutomation.interpreterKind).toBe("time");
    expect(cronAutomation.orgId).toBe(fixture.orgId);
    expect(cronAutomation.userId).toBe(fixture.userId);
    expect(cronAutomation.agentId).toBe(fixture.composeId);
    expect(cronAutomation.instruction).toBe("Existing cron prompt");
    expect(cronAutomation.description).toBe("cron desc");
    // 0442 predates append_system_prompt; the 0444 data carry covers it (its
    // own test below).
    expect(cronAutomation.appendSystemPrompt).toBeNull();
    expect(cronAutomation.enabled).toBeTruthy();
    expect(loopAutomation.enabled).toBeFalsy();

    const [cronTrigger] = await db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.automationId, cronAutomation.id));
    const [loopTrigger] = await db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.automationId, loopAutomation.id));
    expect(cronTrigger).toBeDefined();
    expect(loopTrigger).toBeDefined();
    if (!cronTrigger || !loopTrigger) {
      return;
    }

    // Trigger carries config + runtime state verbatim.
    expect(cronTrigger.kind).toBe("cron");
    expect(cronTrigger.cronExpression).toBe("0 9 * * *");
    expect(cronTrigger.enabled).toBeTruthy();
    expect(cronTrigger.consecutiveFailures).toBe(1);
    expect(cronTrigger.nextRunAt?.toISOString()).toBe(
      "2099-01-01T09:00:00.000Z",
    );

    expect(loopTrigger.kind).toBe("loop");
    expect(loopTrigger.intervalSeconds).toBe(1800);
    expect(loopTrigger.cronExpression).toBeNull();
    expect(loopTrigger.enabled).toBeFalsy();
    expect(loopTrigger.nextRunAt).toBeNull();

    // The backfill creates no run.
    const runs = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.orgId, fixture.orgId));
    expect(runs).toHaveLength(0);
  });

  it("carries append_system_prompt into mirrors that predate the column (0444)", async () => {
    // Simulate a pre-0444 mirror: backfill, then null the column as if the
    // mirror had been written before append_system_prompt existed.
    await runBackfill(fixture.orgId);
    const db = store.set(writeDb$);
    await db.execute(
      sql`UPDATE "automations" SET "append_system_prompt" = NULL WHERE "source_schedule_id" IS NOT NULL`,
    );

    await runAppendPromptCarry();

    const mirrors = await mirrorsForSchedules(fixture.scheduleIds);
    const cronMirror = mirrors.find((row) => {
      return row.instruction === "Existing cron prompt";
    });
    const loopMirror = mirrors.find((row) => {
      return row.instruction === "Existing loop prompt";
    });
    expect(cronMirror?.appendSystemPrompt).toBe("Existing cron append prompt");
    // Sources without an append prompt stay null.
    expect(loopMirror?.appendSystemPrompt).toBeNull();
  });

  it("re-syncs drifted mirrors and maps missed schedules (0446 refresh)", async () => {
    // Map the cron schedule the 0442 way, then simulate runtime drift on the
    // source: the live poller fired (next_run_at moved, lastRunAt stamped,
    // failures counted) without the mirror following.
    await runBackfill(fixture.orgId);
    const db = store.set(writeDb$);
    const [cronId, loopId] = fixture.scheduleIds;
    expect(cronId).toBeDefined();
    expect(loopId).toBeDefined();
    if (!cronId || !loopId) {
      return;
    }

    const driftedNextRun = new Date("2099-02-02T10:00:00.000Z");
    await db
      .update(zeroAgentSchedules)
      .set({
        nextRunAt: driftedNextRun,
        consecutiveFailures: 2,
        enabled: false,
        prompt: "Edited cron prompt",
      })
      .where(eq(zeroAgentSchedules.id, cronId));

    // Simulate a schedule the dual-write missed entirely: delete its mirror.
    await db
      .delete(automations)
      .where(eq(automations.sourceScheduleId, loopId));

    await runRefresh(fixture.orgId);

    const mirrors = await mirrorsForSchedules(fixture.scheduleIds);
    expect(mirrors).toHaveLength(2);
    const cronMirror = mirrors.find((row) => {
      return row.sourceScheduleId === cronId;
    });
    const loopMirror = mirrors.find((row) => {
      return row.sourceScheduleId === loopId;
    });

    // Drifted mapped mirror converged back to the source.
    expect(cronMirror?.instruction).toBe("Edited cron prompt");
    expect(cronMirror?.enabled).toBeFalsy();
    const [cronTrigger] = cronMirror
      ? await db
          .select()
          .from(automationTriggers)
          .where(eq(automationTriggers.automationId, cronMirror.id))
      : [];
    expect(cronTrigger?.nextRunAt?.toISOString()).toBe(
      driftedNextRun.toISOString(),
    );
    expect(cronTrigger?.consecutiveFailures).toBe(2);
    expect(cronTrigger?.enabled).toBeFalsy();

    // Missed schedule got a fresh mirror + trigger.
    expect(loopMirror).toBeDefined();
    if (!loopMirror) {
      return;
    }
    const [loopTrigger] = await db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.automationId, loopMirror.id));
    expect(loopTrigger?.kind).toBe("loop");
    expect(loopTrigger?.intervalSeconds).toBe(1800);

    // Idempotent: a second run changes nothing structurally.
    await runRefresh(fixture.orgId);
    await expect(
      mirrorsForSchedules(fixture.scheduleIds),
    ).resolves.toHaveLength(2);
  });

  it("is a no-op on re-run (no duplicate mirrors)", async () => {
    await runBackfill(fixture.orgId);
    const firstPass = await mirrorsForSchedules(fixture.scheduleIds);
    expect(firstPass).toHaveLength(2);
    const firstIds = new Set(
      firstPass.map((row) => {
        return row.id;
      }),
    );

    // Re-running must insert nothing — same automation rows, same trigger rows.
    await runBackfill(fixture.orgId);
    const secondPass = await mirrorsForSchedules(fixture.scheduleIds);
    expect(secondPass).toHaveLength(2);
    expect(
      new Set(
        secondPass.map((row) => {
          return row.id;
        }),
      ),
    ).toStrictEqual(firstIds);

    const db = store.set(writeDb$);
    const triggers = await db
      .select({ id: automationTriggers.id })
      .from(automationTriggers)
      .where(inArray(automationTriggers.automationId, [...firstIds]));
    expect(triggers).toHaveLength(2);
  });
});
