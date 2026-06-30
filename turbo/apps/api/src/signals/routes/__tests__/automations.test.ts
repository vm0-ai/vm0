import { randomUUID } from "node:crypto";

import {
  automationsByRefContract,
  automationsMainContract,
  automationTriggersContract,
} from "@vm0/api-contracts/contracts/automations";
import { cronExecuteAutomationsContract } from "@vm0/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import {
  type AutomationsFixture,
  cleanupCreatedAutomations,
  deleteExtraCompose,
  deleteAutomationsScenario,
  deleteOrgMembership,
  enableAutomationsFakeKms,
  findAutomationTriggerRows,
  patchAutomationTriggerState,
  readAutomationsState,
  resetAutomationsFakeKms,
  seedAutomationsScenario,
  seedAutomationRun,
  seedExtraCompose,
} from "./helpers/automations";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const SESSION_HEADERS = { authorization: "Bearer clerk-session" } as const;
const CRON_SECRET = "test-cron-secret";
const SCHEDULE_AUTOMATION_DISABLED_MESSAGE =
  "Schedule automation has been disabled. Use zero workflow trigger to create scheduled tasks.";
// Keep global-cron fixtures invisible to parallel test workers using real time.
const ISOLATED_CRON_POLL_TIME_MS = Date.UTC(2099, 0, 1, 0, 0, 0);

function isolatedCronPastDue(): Date {
  return new Date(ISOLATED_CRON_POLL_TIME_MS - 60_000);
}

function isolateCronPollTime(): void {
  mockNow(ISOLATED_CRON_POLL_TIME_MS);
}

afterEach(async () => {
  await resetAutomationsFakeKms(context);
});

function mainApi() {
  return setupApp({ context })(automationsMainContract);
}

function refApi() {
  return setupApp({ context })(automationsByRefContract);
}

function triggerApi() {
  return setupApp({ context })(automationTriggersContract);
}

function cronApi() {
  return setupApp({ context })(cronExecuteAutomationsContract);
}

const trackAutomations = createFixtureTracker<AutomationsFixture>(
  async (fixture) => {
    await deleteFeatureSwitchesForUser(context, fixture);
    await deleteAutomationsScenario(context, fixture);
  },
);

// Automations created through the API are not part of the schedule fixture, so
// delete them by their org scope after each test. The trigger rows cascade
// with the automation; the linked chat threads are removed explicitly.
const trackCreatedAutomations = createFixtureTracker<AutomationsFixture>(
  async (fixture) => {
    await cleanupCreatedAutomations(context, fixture);
  },
);

// Extra agent composes seeded for the ambiguous-name scenario. Registered
// after the automation tracker so this cleanup runs FIRST (vitest unwinds
// afterEach hooks in reverse): the compose cascade removes its automations and
// chat threads before the broader org sweep runs.
const trackExtraComposes = createFixtureTracker<string>(async (composeId) => {
  await deleteExtraCompose(context, composeId);
});

async function seedFixture(): Promise<AutomationsFixture> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  // Pin the description generator to its deterministic template fallback: an
  // ambient key would make description-less creates call openrouter.ai live.
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  context.mocks.s3.send.mockResolvedValue({});
  await enableAutomationsFakeKms(context);
  const fixture = await trackAutomations(
    seedAutomationsScenario(context, { automations: [] }),
  );
  await trackCreatedAutomations(Promise.resolve(fixture));
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function enableScheduleAutomationToWorkflowTriggerSwitch(
  fixture: AutomationsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.SwitchScheduleAutomationToWorkflowTrigger]: true,
  });
}

interface CreateArgs {
  readonly name: string;
  readonly agentId: string;
  readonly instruction?: string;
  readonly description?: string;
  readonly appendSystemPrompt?: string;
  readonly enabled?: boolean;
  readonly trigger?:
    | { readonly kind: "cron"; readonly cronExpression: string }
    | {
        readonly kind: "once";
        readonly atTime: string;
        readonly timezone?: string;
      }
    | { readonly kind: "loop"; readonly intervalSeconds: number };
}

async function createAutomation(args: CreateArgs) {
  const response = await accept(
    mainApi().create({
      headers: SESSION_HEADERS,
      body: {
        name: args.name,
        agentId: args.agentId,
        instruction: args.instruction ?? "Do the automated thing.",
        ...(args.description !== undefined
          ? { description: args.description }
          : {}),
        ...(args.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: args.appendSystemPrompt }
          : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        trigger: args.trigger ?? {
          kind: "cron",
          cronExpression: "0 9 * * *",
        },
      },
    }),
    [201],
  );
  return response.body;
}

async function findTriggerRows(automationId: string) {
  return await findAutomationTriggerRows(context, automationId);
}

describe("Automations API", () => {
  it("creates an automation with a server-created chat thread", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "daily-digest",
      agentId: fixture.composeId,
      instruction: "Summarize the day.",
      description: "Daily digest",
    });

    const { automation } = created;
    expect(automation.name).toBe("daily-digest");
    expect(automation.displayName).toBe("Test Agent");
    expect(automation.userId).toBe(fixture.userId);
    expect(automation.instruction).toBe("Summarize the day.");
    expect(automation.description).toBe("Daily digest");
    expect(automation.enabled).toBeTruthy();
    expect(automation.triggers).toHaveLength(1);
    expect(automation.chatThreadId).toStrictEqual(expect.any(String));
  });

  it("rejects creating an automation when schedule automations are switched to workflow triggers", async () => {
    const fixture = await seedFixture();
    await enableScheduleAutomationToWorkflowTriggerSwitch(fixture);

    const response = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "daily-digest",
          agentId: fixture.composeId,
          instruction: "Summarize the day.",
          trigger: { kind: "cron", cronExpression: "0 9 * * *" },
        },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: SCHEDULE_AUTOMATION_DISABLED_MESSAGE,
      code: "FORBIDDEN",
    });

    const listed = await accept(
      mainApi().list({ headers: SESSION_HEADERS }),
      [200],
    );
    expect(listed.body.automations).toHaveLength(0);
  });

  it("creates an automation with a first cron trigger via sugar", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "cron-sugar",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const [trigger] = created.automation.triggers;
    if (trigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(trigger.cronExpression).toBe("0 9 * * *");
    expect(trigger.timezone).toBe("UTC");
    expect(trigger.enabled).toBeTruthy();
    expect(trigger.nextRunAt).not.toBeNull();
    expect(Date.parse(trigger.nextRunAt!)).toBeGreaterThan(now());
    // An omitted description is generated server-side (template fallback when
    // no model key is configured) — parity with the legacy schedule deploy.
    expect(created.automation.description).toMatch(/recurring task:/u);

    // A cron trigger on a disabled automation stays unscheduled until enable.
    const disabled = await createAutomation({
      name: "cron-sugar-disabled",
      agentId: fixture.composeId,
      enabled: false,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const [disabledTrigger] = disabled.automation.triggers;
    if (disabledTrigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(disabledTrigger.nextRunAt).toBeNull();
  });

  it("rejects enabling a disabled automation when schedule automations are switched to workflow triggers", async () => {
    const fixture = await seedFixture();
    const created = await createAutomation({
      name: "paused-digest",
      agentId: fixture.composeId,
      enabled: false,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    await enableScheduleAutomationToWorkflowTriggerSwitch(fixture);

    const response = await accept(
      refApi().enable({
        headers: SESSION_HEADERS,
        params: { ref: created.automation.id },
        body: {},
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: SCHEDULE_AUTOMATION_DISABLED_MESSAGE,
      code: "FORBIDDEN",
    });

    const shown = await accept(
      refApi().show({
        headers: SESSION_HEADERS,
        params: { ref: created.automation.id },
      }),
      [200],
    );
    expect(shown.body.enabled).toBeFalsy();
  });

  it("rejects enabling a disabled automation trigger when schedule automations are switched to workflow triggers", async () => {
    const fixture = await seedFixture();
    const created = await createAutomation({
      name: "paused-trigger-digest",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const [trigger] = created.automation.triggers;
    if (!trigger) {
      throw new Error("Expected a trigger");
    }
    await accept(
      triggerApi().disable({
        headers: SESSION_HEADERS,
        params: { id: trigger.id },
        body: {},
      }),
      [200],
    );
    await enableScheduleAutomationToWorkflowTriggerSwitch(fixture);

    const response = await accept(
      triggerApi().enable({
        headers: SESSION_HEADERS,
        params: { id: trigger.id },
        body: {},
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: SCHEDULE_AUTOMATION_DISABLED_MESSAGE,
      code: "FORBIDDEN",
    });

    const shown = await accept(
      refApi().show({
        headers: SESSION_HEADERS,
        params: { ref: created.automation.id },
      }),
      [200],
    );
    expect(
      shown.body.triggers.find((candidate) => {
        return candidate.id === trigger.id;
      })?.enabled,
    ).toBeFalsy();
  });

  it("creates and updates one-time triggers by interpreting local atTime in timezone", async () => {
    mockNow(Date.parse("2026-06-22T07:50:00.000Z"));
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "once-local-sugar",
      agentId: fixture.composeId,
      trigger: {
        kind: "once",
        atTime: "2026-06-22T15:55:00",
        timezone: "Asia/Shanghai",
      },
    });
    const [createdTrigger] = created.automation.triggers;
    if (createdTrigger?.kind !== "once") {
      throw new Error("Expected a once trigger");
    }
    expect(createdTrigger.atTime).toBe("2026-06-22T07:55:00.000Z");
    expect(createdTrigger.nextRunAt).toBe("2026-06-22T07:55:00.000Z");
    expect(createdTrigger.timezone).toBe("Asia/Shanghai");

    const updated = await accept(
      triggerApi().update({
        params: { id: createdTrigger.id },
        headers: SESSION_HEADERS,
        body: {
          kind: "once",
          atTime: "2026-06-22T16:10:00",
          timezone: "Asia/Shanghai",
        },
      }),
      [200],
    );
    if (updated.body.kind !== "once") {
      throw new Error("Expected a once trigger");
    }
    expect(updated.body.atTime).toBe("2026-06-22T08:10:00.000Z");
    expect(updated.body.nextRunAt).toBe("2026-06-22T08:10:00.000Z");
  });

  it("keeps explicit one-time instants unchanged", async () => {
    mockNow(Date.parse("2026-06-22T07:50:00.000Z"));
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "once-explicit-offset",
      agentId: fixture.composeId,
      trigger: {
        kind: "once",
        atTime: "2026-06-22T15:55:00+08:00",
        timezone: "UTC",
      },
    });
    const [trigger] = created.automation.triggers;
    if (trigger?.kind !== "once") {
      throw new Error("Expected a once trigger");
    }
    expect(trigger.atTime).toBe("2026-06-22T07:55:00.000Z");
    expect(trigger.nextRunAt).toBe("2026-06-22T07:55:00.000Z");
  });

  it("rejects an invalid cron expression, a past atTime, and a bad timezone", async () => {
    const fixture = await seedFixture();

    const badCron = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "bad-cron",
          agentId: fixture.composeId,
          instruction: "Never.",
          trigger: { kind: "cron", cronExpression: "not a cron" },
        },
      }),
      [400],
    );
    expect(badCron.body.error.code).toBe("BAD_REQUEST");

    const pastAtTime = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "past-once",
          agentId: fixture.composeId,
          instruction: "Past.",
          trigger: {
            kind: "once",
            atTime: new Date(now() - 60_000).toISOString(),
          },
        },
      }),
      [400],
    );
    expect(pastAtTime.body.error.message).toContain("already passed");

    const badTimezone = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "bad-timezone",
          agentId: fixture.composeId,
          instruction: "Bad timezone.",
          trigger: {
            kind: "cron",
            cronExpression: "0 9 * * *",
            timezone: "Mars/Olympus",
          },
        },
      }),
      [400],
    );
    expect(badTimezone.body.error.message).toContain("Invalid timezone");
  });

  it("rejects a duplicate name on the same agent", async () => {
    const fixture = await seedFixture();

    await createAutomation({ name: "dup", agentId: fixture.composeId });
    const conflictResponse = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "dup",
          agentId: fixture.composeId,
          instruction: "Again.",
          trigger: { kind: "cron", cronExpression: "0 10 * * *" },
        },
      }),
      [400],
    );
    expect(conflictResponse.body.error.message).toContain("already exists");
  });

  it("rejects an ambiguous name ref and still resolves by id", async () => {
    const fixture = await seedFixture();

    const extraComposeId = await trackExtraComposes(
      Promise.resolve(randomUUID()),
    );
    await seedExtraCompose(context, fixture, extraComposeId);

    const first = await createAutomation({
      name: "shared-name",
      agentId: fixture.composeId,
    });
    await createAutomation({ name: "shared-name", agentId: extraComposeId });

    const ambiguous = await accept(
      refApi().show({
        params: { ref: "shared-name" },
        headers: SESSION_HEADERS,
      }),
      [400],
    );
    expect(ambiguous.body.error.message).toContain("Ambiguous");

    const byId = await accept(
      refApi().show({
        params: { ref: first.automation.id },
        headers: SESSION_HEADERS,
      }),
      [200],
    );
    expect(byId.body.id).toBe(first.automation.id);
  });

  it("shows and lists automations with their schedule trigger", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "scheduled",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });

    const shown = await accept(
      refApi().show({
        params: { ref: "scheduled" },
        headers: SESSION_HEADERS,
      }),
      [200],
    );
    expect(shown.body.triggers).toHaveLength(1);
    expect(shown.body.triggers[0]?.kind).toBe("cron");

    const listed = await accept(
      mainApi().list({ headers: SESSION_HEADERS }),
      [200],
    );
    expect(listed.body.automations).toHaveLength(1);
    expect(listed.body.automations[0]?.id).toBe(created.automation.id);
    expect(listed.body.automations[0]?.triggers).toHaveLength(1);
  });

  it("updates identity fields and rejects a rename onto a taken name", async () => {
    const fixture = await seedFixture();

    await createAutomation({
      name: "alpha",
      agentId: fixture.composeId,
      description: "before",
    });
    await createAutomation({ name: "beta", agentId: fixture.composeId });

    const updated = await accept(
      refApi().update({
        params: { ref: "alpha" },
        headers: SESSION_HEADERS,
        body: { instruction: "Updated instruction.", description: null },
      }),
      [200],
    );
    expect(updated.body.instruction).toBe("Updated instruction.");
    expect(updated.body.description).toBeNull();
    expect(updated.body.name).toBe("alpha");

    const renameConflict = await accept(
      refApi().update({
        params: { ref: "alpha" },
        headers: SESSION_HEADERS,
        body: { name: "beta" },
      }),
      [400],
    );
    expect(renameConflict.body.error.message).toContain("already exists");

    const renamed = await accept(
      refApi().update({
        params: { ref: "alpha" },
        headers: SESSION_HEADERS,
        body: { name: "gamma" },
      }),
      [200],
    );
    expect(renamed.body.name).toBe("gamma");
  });

  it("disable clears time-trigger next runs and enable recomputes them", async () => {
    const fixture = await seedFixture();
    mockEnv("CRON_SECRET", CRON_SECRET);

    const created = await createAutomation({
      name: "suspend-me",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const automationId = created.automation.id;
    const dueTime = new Date(now() - 60_000);
    await patchAutomationTriggerState(context, {
      automation_id: automationId,
      next_run_at: dueTime,
    });

    const disabled = await accept(
      refApi().disable({
        params: { ref: "suspend-me" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    // Disable clears next_run_at on the time trigger so the poller stops seeing
    // it (#17546), but leaves the trigger's own enabled flag intact.
    const [suspended] = await findTriggerRows(automationId);
    expect(suspended?.enabled).toBeTruthy();
    expect(suspended?.next_run_at).toBeNull();

    // The poller's SQL filter no longer surfaces the disabled automation's
    // trigger at all, so it is neither claimed nor counted as skipped.
    const cronResponse = await accept(
      cronApi().execute({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(cronResponse.body.executed).toBe(0);
    await expect(
      readAutomationsState(context, { automationIds: [automationId] }),
    ).resolves.toMatchObject({ runs: [] });

    const enabled = await accept(
      refApi().enable({
        params: { ref: "suspend-me" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    const [cronTrigger] = enabled.body.triggers;
    if (cronTrigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    // No catch-up: the stale due time is replaced by the next occurrence.
    expect(Date.parse(cronTrigger.nextRunAt!)).toBeGreaterThan(now());

    // An expired one-time trigger is disabled on enable instead of firing.
    const onceAutomation = await createAutomation({
      name: "expired-on-enable",
      agentId: fixture.composeId,
      enabled: false,
      trigger: {
        kind: "once",
        atTime: new Date(now() + 3_600_000).toISOString(),
      },
    });
    const [onceTriggerBefore] = onceAutomation.automation.triggers;
    if (onceTriggerBefore?.kind !== "once") {
      throw new Error("Expected a once trigger");
    }
    await patchAutomationTriggerState(context, {
      trigger_id: onceTriggerBefore.id,
      at_time: dueTime,
      next_run_at: dueTime,
    });

    const enabledOnce = await accept(
      refApi().enable({
        params: { ref: "expired-on-enable" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    const [onceTrigger] = enabledOnce.body.triggers;
    if (onceTrigger?.kind !== "once") {
      throw new Error("Expected a once trigger");
    }
    expect(onceTrigger.enabled).toBeFalsy();
    expect(onceTrigger.nextRunAt).toBeNull();
  });

  it("creating a loop trigger on a disabled automation leaves next run unscheduled", async () => {
    const fixture = await seedFixture();

    const disabled = await createAutomation({
      name: "loop-disabled",
      agentId: fixture.composeId,
      enabled: false,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const [loopTrigger] = disabled.automation.triggers;
    if (loopTrigger?.kind !== "loop") {
      throw new Error("Expected a loop trigger");
    }
    // A loop trigger is always due by design; gating its next run on the
    // automation flag stops a disabled automation from minting a permanently-due
    // "zombie" row (#17546).
    expect(loopTrigger.nextRunAt).toBeNull();
  });

  it("disable clears the next run but keeps enabled and last run; re-enable recomputes", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "round-trip",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const automationId = created.automation.id;

    // Stamp a last run on the trigger to prove disable does not clear it.
    const fakeRunId = await seedAutomationRun(context, fixture);
    await patchAutomationTriggerState(context, {
      automation_id: automationId,
      last_run_id: fakeRunId,
    });

    const disabled = await accept(
      refApi().disable({
        params: { ref: "round-trip" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    const suspendedRows = await findTriggerRows(automationId);
    for (const row of suspendedRows) {
      expect(row.next_run_at).toBeNull();
      expect(row.enabled).toBeTruthy();
      expect(row.last_run_id).toBe(fakeRunId);
    }

    const enabled = await accept(
      refApi().enable({
        params: { ref: "round-trip" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    const [cronTrigger] = enabled.body.triggers;
    if (cronTrigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(Date.parse(cronTrigger.nextRunAt!)).toBeGreaterThan(now());

    // The last-run history (an internal column) survives the round trip.
    const enabledRows = await findTriggerRows(automationId);
    for (const row of enabledRows) {
      expect(row.last_run_id).toBe(fakeRunId);
    }
  });

  it("the poller does not let disabled-automation zombies starve a due trigger", async () => {
    // #17546 regression: historically, disabling an automation left its loop
    // trigger enabled with a past next_run_at (a permanently-due "zombie"). With
    // >10 such rows, the old unordered LIMIT 10 batch filled with zombies every
    // tick and a genuinely-due trigger never got claimed. The SQL automation
    // filter plus the raised batch cap fix it.
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    context.mocks.s3.send.mockResolvedValue({});
    await enableAutomationsFakeKms(context);
    mockEnv("CRON_SECRET", CRON_SECRET);

    const pastDue = isolatedCronPastDue();
    const fixture = await trackAutomations(
      seedAutomationsScenario(context, {
        automations: [
          // 12 zombies: enabled loop triggers, automation flag flipped off
          // below. >10 proves the old LIMIT 10 starvation.
          ...Array.from({ length: 12 }, (_, index) => {
            return {
              name: `zombie-${index}`,
              prompt: "Zombie task",
              triggerType: "loop" as const,
              intervalSeconds: 300,
              enabled: false,
              nextRunAt: pastDue,
            };
          }),
          // The one healthy, enabled automation with a due loop trigger.
          {
            name: "healthy",
            prompt: "Healthy task",
            triggerType: "loop" as const,
            intervalSeconds: 300,
            enabled: true,
            nextRunAt: pastDue,
          },
        ],
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // Seed zombies disabled, then restore only their trigger state. That avoids
    // a race window where another test worker's global cron can claim them
    // before this test has built the historical zombie shape (trigger
    // enabled=true, next_run_at in the past, automation enabled=false).
    const zombieIds = fixture.automationIds.slice(0, 12);
    const healthyId = fixture.automationIds[12]!;
    await Promise.all(
      zombieIds.map((automationId) => {
        return patchAutomationTriggerState(context, {
          automation_id: automationId,
          enabled: true,
          next_run_at: pastDue,
        });
      }),
    );

    isolateCronPollTime();
    const response = await accept(
      cronApi().execute({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    // The route reports global counts, so assert the local side effect instead:
    // the healthy trigger was claimed and run despite 12 starving zombies.
    expect(response.body.success).toBeTruthy();

    const [healthyTrigger] = await findTriggerRows(healthyId);
    expect(healthyTrigger?.next_run_at).toBeNull();
    expect(healthyTrigger?.last_run_id).not.toBeNull();
    const { runs: healthyRuns } = await readAutomationsState(context, {
      automationIds: [healthyId],
    });
    expect(healthyRuns).toHaveLength(1);
    const healthyRunId = healthyRuns[0]?.id;
    if (!healthyRunId) {
      throw new Error("Expected healthy automation run");
    }
    const callbacks = (
      await readAutomationsState(context, { runId: healthyRunId })
    ).run?.callbacks;
    expect(callbacks).toStrictEqual(
      expect.arrayContaining([
        {
          url: null,
          internal_kind: "trigger:loop",
          payload: { triggerId: healthyTrigger?.id },
        },
      ]),
    );
    expect(
      callbacks?.some((callback) => {
        return callback.url === null && callback.internal_kind === "chat";
      }),
    ).toBeTruthy();

    // The zombies were never touched: still due, never run.
    const zombieState = await readAutomationsState(context, {
      automationIds: zombieIds,
    });
    const zombieTriggers = zombieState.triggers;
    expect(zombieTriggers).toHaveLength(12);
    for (const zombie of zombieTriggers) {
      expect(zombie.next_run_at).toBe(pastDue.toISOString());
      expect(zombie.last_run_id).toBeNull();
    }
    expect(zombieState.runs).toHaveLength(0);
  });

  it("suspends due time automations whose owner is no longer an org member", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    context.mocks.s3.send.mockResolvedValue({});
    await enableAutomationsFakeKms(context);
    mockEnv("CRON_SECRET", CRON_SECRET);

    const pastDue = isolatedCronPastDue();
    const fixture = await trackAutomations(
      seedAutomationsScenario(context, {
        automations: [
          {
            name: "orphaned-member",
            prompt: "Should not run after membership removal",
            triggerType: "cron",
            cronExpression: "0 9 * * *",
            enabled: true,
            nextRunAt: pastDue,
          },
        ],
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await deleteOrgMembership(context, fixture);

    const automationId = fixture.automationIds[0]!;
    isolateCronPollTime();
    const response = await accept(
      cronApi().execute({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(response.body.skipped).toBeGreaterThanOrEqual(1);

    const storedState = await readAutomationsState(context, {
      automationId,
      automationIds: [automationId],
    });
    expect(storedState.automation?.enabled).toBeFalsy();

    const [storedTrigger] = storedState.triggers;
    expect(storedTrigger).toStrictEqual({
      id: expect.any(String),
      automation_id: automationId,
      kind: "cron",
      cron_expression: "0 9 * * *",
      at_time: null,
      interval_seconds: null,
      timezone: "UTC",
      enabled: false,
      next_run_at: null,
      last_run_id: null,
      consecutive_failures: 0,
    });
    expect(storedState.runs).toHaveLength(0);
  });

  it("enables and disables a single trigger", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "per-trigger",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const cronTriggerId = created.automation.triggers[0]!.id;

    const disabledTrigger = await accept(
      triggerApi().disable({
        params: { id: cronTriggerId },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(disabledTrigger.body.enabled).toBeFalsy();
    if (disabledTrigger.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    // Disabling leaves the time state as-is; the poller skips via the flag.
    expect(disabledTrigger.body.nextRunAt).not.toBeNull();

    const enabledTrigger = await accept(
      triggerApi().enable({
        params: { id: cronTriggerId },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(enabledTrigger.body.enabled).toBeTruthy();
    if (enabledTrigger.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(Date.parse(enabledTrigger.body.nextRunAt!)).toBeGreaterThan(now());

    // Re-enabling an expired one-time trigger is rejected.
    const onceAutomation = await createAutomation({
      name: "per-trigger-once",
      agentId: fixture.composeId,
      trigger: {
        kind: "once",
        atTime: new Date(now() + 3_600_000).toISOString(),
      },
    });
    const onceTriggerId = onceAutomation.automation.triggers[0]!.id;
    await patchAutomationTriggerState(context, {
      trigger_id: onceTriggerId,
      at_time: new Date(now() - 60_000),
      next_run_at: null,
      enabled: false,
    });
    const expired = await accept(
      triggerApi().enable({
        params: { id: onceTriggerId },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [400],
    );
    expect(expired.body.error.message).toContain("already passed");
  });

  it("updates a trigger's schedule in place, preserving id and run history", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "retime-me",
      agentId: fixture.composeId,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const triggerId = created.automation.triggers[0]!.id;

    // A manual fire stamps lastRunId; a seeded failure count exercises the
    // revive semantics (the counter resets on update, like enable).
    const runResponse = await accept(
      refApi().run({
        params: { ref: "retime-me" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [201],
    );
    await patchAutomationTriggerState(context, {
      trigger_id: triggerId,
      consecutive_failures: 2,
    });

    const updated = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: { kind: "loop", intervalSeconds: 600 },
      }),
      [200],
    );
    if (updated.body.kind !== "loop") {
      throw new Error("Expected a loop trigger");
    }
    expect(updated.body.id).toBe(triggerId);
    expect(updated.body.intervalSeconds).toBe(600);
    expect(updated.body.consecutiveFailures).toBe(0);
    expect(updated.body.nextRunAt).not.toBeNull();

    const [row] = await findTriggerRows(created.automation.id);
    expect(row?.last_run_id).toBe(runResponse.body.runId);

    // The kind may switch: loop → cron swaps the config columns in place.
    const switched = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: {
          kind: "cron",
          cronExpression: "0 9 * * *",
          timezone: "Asia/Shanghai",
        },
      }),
      [200],
    );
    if (switched.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(switched.body.id).toBe(triggerId);
    expect(switched.body.cronExpression).toBe("0 9 * * *");
    expect(switched.body.timezone).toBe("Asia/Shanghai");
    expect(Date.parse(switched.body.nextRunAt!)).toBeGreaterThan(now());

    const [switchedRow] = await findTriggerRows(created.automation.id);
    expect(switchedRow?.kind).toBe("cron");
    expect(switchedRow?.interval_seconds).toBeNull();
    expect(switchedRow?.at_time).toBeNull();
    expect(switchedRow?.last_run_id).toBe(runResponse.body.runId);
    expect(switchedRow?.enabled).toBeTruthy();
  });

  it("rejects invalid schedule updates", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "update-validate",
      agentId: fixture.composeId,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const triggerId = created.automation.triggers[0]!.id;

    const pastOnce = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: { kind: "once", atTime: new Date(now() - 60_000).toISOString() },
      }),
      [400],
    );
    expect(pastOnce.body.error.message).toContain("already passed");

    const badCron = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: { kind: "cron", cronExpression: "not a cron" },
      }),
      [400],
    );
    expect(badCron.body.error.message).toContain("Invalid cron expression");

    // A failed validation leaves the row untouched.
    const [row] = await findTriggerRows(created.automation.id);
    expect(row?.kind).toBe("loop");
    expect(row?.interval_seconds).toBe(300);
  });

  it("scopes trigger updates to the caller and gates cron next runs on the automation flag", async () => {
    const fixture = await seedFixture();

    // Another user's trigger resolves as not found.
    const otherFixture = await trackAutomations(
      seedAutomationsScenario(context, {
        automations: [
          { name: "other-loop", prompt: "Other task", intervalSeconds: 300 },
        ],
      }),
    );
    const [otherTrigger] = await findTriggerRows(
      otherFixture.automationIds[0]!,
    );
    const denied = await accept(
      triggerApi().update({
        params: { id: otherTrigger!.id },
        headers: SESSION_HEADERS,
        body: { kind: "loop", intervalSeconds: 600 },
      }),
      [404],
    );
    expect(denied.body.error.code).toBe("NOT_FOUND");

    // Switching to cron on a disabled automation keeps next run unscheduled
    // (the same gating creation applies).
    const created = await createAutomation({
      name: "disabled-retime",
      agentId: fixture.composeId,
      enabled: false,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const updated = await accept(
      triggerApi().update({
        params: { id: created.automation.triggers[0]!.id },
        headers: SESSION_HEADERS,
        body: { kind: "cron", cronExpression: "0 9 * * *" },
      }),
      [200],
    );
    if (updated.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(updated.body.nextRunAt).toBeNull();
  });

  it("manually fires an automation: chat callback only, automation-only provenance", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "fire-now",
      agentId: fixture.composeId,
      instruction: "Manual run test",
      description: "Manual run description",
      appendSystemPrompt: "Use the run context.",
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });

    const runResponse = await accept(
      refApi().run({
        params: { ref: "fire-now" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [201],
    );
    const { runId } = runResponse.body;

    const runState = (await readAutomationsState(context, { runId })).run;
    // Provenance: the automation alone — no trigger fired this run. B2 is
    // deferred, so the run records the automation trigger source.
    expect(runState?.zero_run).toStrictEqual({
      trigger_source: "automation",
      automation_id: created.automation.id,
      trigger_id: null,
      chat_thread_id: created.automation.chatThreadId,
    });

    expect(runState?.agent_run?.prompt).toBe("Manual run test");
    expect(runState?.agent_run?.append_system_prompt).toContain(
      "Trigger type: manual",
    );
    expect(runState?.agent_run?.append_system_prompt).toContain(
      "Use the run context.",
    );

    // Only the chat callback: nothing was claimed, so there is no reschedule.
    const callbacks = runState?.callbacks ?? [];
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({
      url: null,
      internal_kind: "chat",
    });

    // The prompt renders as a user chat message with the automation chip.
    const chipMessage = runState?.messages.find((message) => {
      return message.role === "user" && message.content === "Manual run test";
    });
    expect(chipMessage).toMatchObject({
      automation_title: "fire-now",
      automation_snapshot: { id: created.automation.id, title: "fire-now" },
    });
    // The manual run is stamped on the trigger, so a second fire conflicts
    // while it is still active (per-trigger skip-if-active semantics).
    const [trigger] = await findTriggerRows(created.automation.id);
    expect(trigger?.last_run_id).toBe(runId);
    const conflictResponse = await accept(
      refApi().run({
        params: { ref: "fire-now" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [409],
    );
    expect(conflictResponse.body.error.code).toBe("CONFLICT");
  });

  it("manually fires an automation without binding the run to a trigger", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "manual-unbound-run",
      agentId: fixture.composeId,
    });
    const runResponse = await accept(
      refApi().run({
        params: { ref: created.automation.id },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [201],
    );

    const runState = (
      await readAutomationsState(context, { runId: runResponse.body.runId })
    ).run;
    expect(runState?.zero_run).toMatchObject({
      automation_id: created.automation.id,
      trigger_id: null,
    });
  });

  it("deletes an automation and cascades its trigger", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "remove-me",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    await expect(findTriggerRows(created.automation.id)).resolves.toHaveLength(
      1,
    );

    await accept(
      refApi().delete({
        params: { ref: "remove-me" },
        headers: SESSION_HEADERS,
      }),
      [204],
    );
    await accept(
      refApi().show({
        params: { ref: created.automation.id },
        headers: SESSION_HEADERS,
      }),
      [404],
    );
    await expect(findTriggerRows(created.automation.id)).resolves.toHaveLength(
      0,
    );
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(mainApi().list({ headers: {} }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
