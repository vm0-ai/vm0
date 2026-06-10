import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../../lib/env";
import { writeDb$ } from "../../../external/db";
import {
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
  type SchedulesFixture,
} from "../../../routes/__tests__/helpers/zero-schedules";
import { createFixtureTracker } from "../../../routes/__tests__/helpers/zero-route-test";
import {
  deleteSchedule$,
  deploySchedule$,
  disableSchedule$,
  enableSchedule$,
} from "../../zero-schedules.service";

const context = testContext();
const store = createStore();

const track = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

async function seedFixture(): Promise<SchedulesFixture> {
  // No OpenRouter key -> deploySchedule$ uses the template-description fallback,
  // so the dual-write path runs without an outbound model call.
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  return await track(
    store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
  );
}

interface MirrorState {
  readonly automation: typeof automations.$inferSelect;
  readonly trigger: typeof automationTriggers.$inferSelect;
}

// Read the events-first mirror of a schedule (the automation keyed on
// source_schedule_id plus its single time trigger). Asserts the 1:1 shape the
// dual-write maintains; returns null when no mirror exists.
async function readMirror(scheduleId: string): Promise<MirrorState | null> {
  const db = store.set(writeDb$);
  const [automation] = await db
    .select()
    .from(automations)
    .where(eq(automations.sourceScheduleId, scheduleId))
    .limit(1);
  if (!automation) {
    return null;
  }
  const [trigger] = await db
    .select()
    .from(automationTriggers)
    .where(eq(automationTriggers.automationId, automation.id))
    .limit(1);
  if (!trigger) {
    throw new Error("readMirror: automation has no trigger row");
  }
  return { automation, trigger };
}

async function runCountForOrg(orgId: string): Promise<number> {
  const db = store.set(writeDb$);
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, orgId));
  return rows.length;
}

async function loadSchedule(
  scheduleId: string,
): Promise<typeof zeroAgentSchedules.$inferSelect> {
  const db = store.set(writeDb$);
  const [schedule] = await db
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId))
    .limit(1);
  if (!schedule) {
    throw new Error(`loadSchedule: schedule ${scheduleId} not found`);
  }
  return schedule;
}

describe("schedule dual-write to events-first tables", () => {
  let fixture: SchedulesFixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("mirrors a created schedule into automations + a time trigger", async () => {
    const result = await store.set(
      deploySchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        body: {
          agentId: fixture.composeId,
          name: "daily-report",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Summarize yesterday",
          enabled: true,
        },
      },
      context.signal,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    const scheduleId = result.response.schedule.id;
    const schedule = await loadSchedule(scheduleId);

    const mirror = await readMirror(scheduleId);
    expect(mirror).not.toBeNull();
    if (!mirror) {
      return;
    }

    expect(mirror.automation.interpreterKind).toBe("time");
    expect(mirror.automation.sourceScheduleId).toBe(scheduleId);
    expect(mirror.automation.orgId).toBe(fixture.orgId);
    expect(mirror.automation.userId).toBe(fixture.userId);
    expect(mirror.automation.agentId).toBe(fixture.composeId);
    expect(mirror.automation.chatThreadId).toBe(schedule.chatThreadId);
    expect(mirror.automation.instruction).toBe("Summarize yesterday");
    expect(mirror.automation.enabled).toBeTruthy();

    expect(mirror.trigger.kind).toBe("cron");
    expect(mirror.trigger.cronExpression).toBe("0 9 * * *");
    expect(mirror.trigger.timezone).toBe("UTC");
    expect(mirror.trigger.enabled).toBeTruthy();
    // Runtime state is carried over verbatim from the schedule.
    expect(mirror.trigger.nextRunAt?.getTime()).toBe(
      schedule.nextRunAt?.getTime(),
    );

    // Pure data-sync: dual-write creates no run.
    await expect(runCountForOrg(fixture.orgId)).resolves.toBe(0);
  });

  it("updates the same mirror in place when the schedule is re-deployed", async () => {
    const created = await store.set(
      deploySchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        body: {
          agentId: fixture.composeId,
          name: "evolving",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "First prompt",
          enabled: true,
        },
      },
      context.signal,
    );
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") {
      return;
    }
    const scheduleId = created.response.schedule.id;
    const first = await readMirror(scheduleId);
    expect(first).not.toBeNull();

    const updated = await store.set(
      deploySchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        body: {
          agentId: fixture.composeId,
          name: "evolving",
          intervalSeconds: 3600,
          timezone: "UTC",
          prompt: "Second prompt",
          enabled: true,
        },
      },
      context.signal,
    );
    expect(updated.kind).toBe("ok");
    if (updated.kind !== "ok") {
      return;
    }
    // Same schedule row -> idempotent: one automation, one trigger, updated.
    expect(updated.response.schedule.id).toBe(scheduleId);
    const second = await readMirror(scheduleId);
    expect(second).not.toBeNull();
    if (!first || !second) {
      return;
    }
    expect(second.automation.id).toBe(first.automation.id);
    expect(second.trigger.id).toBe(first.trigger.id);
    expect(second.automation.instruction).toBe("Second prompt");
    expect(second.trigger.kind).toBe("loop");
    expect(second.trigger.intervalSeconds).toBe(3600);
    expect(second.trigger.cronExpression).toBeNull();

    // Exactly one mirror automation for this schedule.
    const db = store.set(writeDb$);
    const all = await db
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.sourceScheduleId, scheduleId));
    expect(all).toHaveLength(1);

    await expect(runCountForOrg(fixture.orgId)).resolves.toBe(0);
  });

  it("mirrors disable then enable onto the trigger", async () => {
    const created = await store.set(
      deploySchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        body: {
          agentId: fixture.composeId,
          name: "toggle",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Toggle me",
          enabled: true,
        },
      },
      context.signal,
    );
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") {
      return;
    }
    const scheduleId = created.response.schedule.id;

    const disabled = await store.set(
      disableSchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        agentId: fixture.composeId,
        name: "toggle",
      },
      context.signal,
    );
    expect(disabled.kind).toBe("ok");
    const afterDisable = await readMirror(scheduleId);
    expect(afterDisable?.automation.enabled).toBeFalsy();
    expect(afterDisable?.trigger.enabled).toBeFalsy();

    const enabled = await store.set(
      enableSchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        agentId: fixture.composeId,
        name: "toggle",
      },
      context.signal,
    );
    expect(enabled.kind).toBe("ok");
    const afterEnable = await readMirror(scheduleId);
    const schedule = await loadSchedule(scheduleId);
    expect(afterEnable?.automation.enabled).toBeTruthy();
    expect(afterEnable?.trigger.enabled).toBeTruthy();
    // Enable recomputes nextRunAt; the mirror reflects it.
    expect(afterEnable?.trigger.nextRunAt?.getTime()).toBe(
      schedule.nextRunAt?.getTime(),
    );

    await expect(runCountForOrg(fixture.orgId)).resolves.toBe(0);
  });

  it("removes the mirror when the schedule is deleted", async () => {
    const created = await store.set(
      deploySchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        body: {
          agentId: fixture.composeId,
          name: "ephemeral",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Delete me",
          enabled: true,
        },
      },
      context.signal,
    );
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") {
      return;
    }
    const scheduleId = created.response.schedule.id;
    const mirror = await readMirror(scheduleId);
    expect(mirror).not.toBeNull();
    const automationId = mirror?.automation.id;

    const deleted = await store.set(
      deleteSchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        agentId: fixture.composeId,
        name: "ephemeral",
      },
      context.signal,
    );
    expect(deleted.kind).toBe("ok");

    // The automation mirror is gone, and its trigger went with it (FK cascade).
    await expect(readMirror(scheduleId)).resolves.toBeNull();
    if (automationId) {
      const db = store.set(writeDb$);
      const triggers = await db
        .select({ id: automationTriggers.id })
        .from(automationTriggers)
        .where(eq(automationTriggers.automationId, automationId));
      expect(triggers).toHaveLength(0);
    }

    await expect(runCountForOrg(fixture.orgId)).resolves.toBe(0);
  });

  it("deploys the schedule even when the mirror write hits a name collision", async () => {
    // A natively-created (webhook) automation already occupies the
    // (agent, name, org, user) slot the mirror insert will want — the
    // idx_automations_agent_name_org_user unique index makes the mirror
    // insert throw. Best-effort dual-write must swallow it.
    const db = store.set(writeDb$);
    const [thread] = await db
      .insert(chatThreads)
      .values({ userId: fixture.userId, agentComposeId: fixture.composeId })
      .returning({ id: chatThreads.id });
    expect(thread).toBeDefined();
    if (!thread) {
      return;
    }
    await db.insert(automations).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "collide",
      instruction: "Native webhook automation",
      agentId: fixture.composeId,
      chatThreadId: thread.id,
      interpreterKind: "webhook",
    });

    const result = await store.set(
      deploySchedule$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        body: {
          agentId: fixture.composeId,
          name: "collide",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Collide with native automation",
          enabled: true,
        },
      },
      context.signal,
    );

    // The schedule deploy itself succeeds; only the mirror is missing.
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    const scheduleId = result.response.schedule.id;
    await expect(loadSchedule(scheduleId)).resolves.toBeDefined();
    await expect(readMirror(scheduleId)).resolves.toBeNull();
  });

  it("is a no-op delete when the schedule has no mirror", async () => {
    // Seed a schedule directly (no dual-write), then delete it: deleteSchedule$
    // must succeed even though no events-first mirror exists.
    const seeded = await track(
      store.set(
        seedSchedulesScenario$,
        {
          schedules: [
            {
              name: "unmirrored",
              cronExpression: "0 9 * * *",
              prompt: "No mirror",
              enabled: true,
            },
          ],
        },
        context.signal,
      ),
    );
    const scheduleId = seeded.scheduleIds[0];
    expect(scheduleId).toBeDefined();
    if (!scheduleId) {
      return;
    }
    await expect(readMirror(scheduleId)).resolves.toBeNull();

    const deleted = await store.set(
      deleteSchedule$,
      {
        userId: seeded.userId,
        orgId: seeded.orgId,
        agentId: seeded.composeId,
        name: "unmirrored",
      },
      context.signal,
    );
    expect(deleted.kind).toBe("ok");

    const db = store.set(writeDb$);
    const [stillThere] = await db
      .select({ id: zeroAgentSchedules.id })
      .from(zeroAgentSchedules)
      .where(
        and(
          eq(zeroAgentSchedules.id, scheduleId),
          eq(zeroAgentSchedules.orgId, seeded.orgId),
        ),
      )
      .limit(1);
    expect(stillThere).toBeUndefined();
  });
});
