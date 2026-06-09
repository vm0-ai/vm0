import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
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

// The one-time, idempotent backfill data migration under test.
const BACKFILL_SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../../../packages/db/src/migrations/0442_backfill_schedules_to_automations.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

async function runBackfill(): Promise<void> {
  const db = store.set(writeDb$);
  await db.execute(sql.raw(BACKFILL_SQL));
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

    await runBackfill();

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

  it("is a no-op on re-run (no duplicate mirrors)", async () => {
    await runBackfill();
    const firstPass = await mirrorsForSchedules(fixture.scheduleIds);
    expect(firstPass).toHaveLength(2);
    const firstIds = new Set(
      firstPass.map((row) => {
        return row.id;
      }),
    );

    // Re-running must insert nothing — same automation rows, same trigger rows.
    await runBackfill();
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
