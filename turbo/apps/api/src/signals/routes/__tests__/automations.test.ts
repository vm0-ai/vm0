import { randomUUID } from "node:crypto";

import {
  automationsByRefContract,
  automationsMainContract,
  automationTriggersContract,
} from "@vm0/api-contracts/contracts/automations";
import { cronExecuteAutomationsContract } from "@vm0/api-contracts/contracts/cron";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import {
  type AutomationsFixture,
  deleteAutomationsScenario,
  deleteOrgMembership,
  enableAutomationsFakeKms,
  patchAutomationTriggerState,
  readAutomationsState,
  resetAutomationsFakeKms,
  seedAutomationsScenario,
} from "./helpers/automations";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { deleteFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

/**
 * The legacy automations surface is FROZEN after the automation -> workflow
 * cutover (#19959, migration 0534): every mutating route returns 403
 * unconditionally, while list/show stay readable so users can inspect their
 * migrated provenance rows. The poller and cron route remain live for any
 * unmigrated stragglers until the legacy removal lands, so their regression
 * tests are kept on seeded (DB-level) fixtures.
 */

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

async function seedFixture(
  automations: Parameters<
    typeof seedAutomationsScenario
  >[1]["automations"] = [],
): Promise<AutomationsFixture> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  context.mocks.s3.send.mockResolvedValue({});
  await enableAutomationsFakeKms(context);
  const fixture = await trackAutomations(
    seedAutomationsScenario(context, { automations }),
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

function expectFrozen(response: { body: { error: unknown } }): void {
  expect(response.body.error).toStrictEqual({
    message: SCHEDULE_AUTOMATION_DISABLED_MESSAGE,
    code: "FORBIDDEN",
  });
}

describe("Automations API (frozen legacy surface)", () => {
  it("returns 403 for every mutating route", async () => {
    await seedFixture();
    const ref = randomUUID();
    const triggerId = randomUUID();

    expectFrozen(
      await accept(
        mainApi().create({
          headers: SESSION_HEADERS,
          body: {
            name: "daily-digest",
            agentId: randomUUID(),
            instruction: "Summarize the day.",
            trigger: { kind: "cron", cronExpression: "0 9 * * *" },
          },
        }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        refApi().update({
          headers: SESSION_HEADERS,
          params: { ref },
          body: { instruction: "New instruction" },
        }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        refApi().delete({ headers: SESSION_HEADERS, params: { ref } }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        refApi().run({ headers: SESSION_HEADERS, params: { ref }, body: {} }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        refApi().enable({
          headers: SESSION_HEADERS,
          params: { ref },
          body: {},
        }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        refApi().disable({
          headers: SESSION_HEADERS,
          params: { ref },
          body: {},
        }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        triggerApi().update({
          headers: SESSION_HEADERS,
          params: { id: triggerId },
          body: { kind: "cron", cronExpression: "0 10 * * *" },
        }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        triggerApi().enable({
          headers: SESSION_HEADERS,
          params: { id: triggerId },
          body: {},
        }),
        [403],
      ),
    );
    expectFrozen(
      await accept(
        triggerApi().disable({
          headers: SESSION_HEADERS,
          params: { id: triggerId },
          body: {},
        }),
        [403],
      ),
    );
  });

  it("keeps seeded automations readable through list and show", async () => {
    // Seeded disabled so no foreign worker's global cron sweep can claim them.
    const fixture = await seedFixture([
      {
        name: "frozen-cron",
        prompt: "Cron task",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        enabled: false,
      },
      {
        name: "frozen-loop",
        prompt: "Loop task",
        triggerType: "loop",
        intervalSeconds: 300,
        enabled: false,
      },
    ]);

    const listed = await accept(
      mainApi().list({ headers: SESSION_HEADERS }),
      [200],
    );
    expect(listed.body.automations).toHaveLength(2);
    expect(
      listed.body.automations.map((automation) => {
        return automation.name;
      }),
    ).toStrictEqual(expect.arrayContaining(["frozen-cron", "frozen-loop"]));

    const cronId = fixture.automationIds[0]!;
    const shown = await accept(
      refApi().show({ headers: SESSION_HEADERS, params: { ref: cronId } }),
      [200],
    );
    expect(shown.body.name).toBe("frozen-cron");
    expect(shown.body.enabled).toBeFalsy();
    expect(shown.body.triggers).toHaveLength(1);
    const [trigger] = shown.body.triggers;
    if (trigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(trigger.cronExpression).toBe("0 9 * * *");

    const shownTrigger = await accept(
      triggerApi().show({
        headers: SESSION_HEADERS,
        params: { id: trigger.id },
      }),
      [200],
    );
    expect(shownTrigger.body.id).toBe(trigger.id);
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

    const healthyAutomation = await accept(
      refApi().show({
        params: { ref: healthyId },
        headers: SESSION_HEADERS,
      }),
      [200],
    );
    const [healthyTrigger] = healthyAutomation.body.triggers;
    if (healthyTrigger?.kind !== "loop") {
      throw new Error("Expected a loop trigger");
    }
    expect(healthyTrigger.nextRunAt).toBeNull();
    expect(healthyTrigger.lastRunAt).not.toBeNull();

    // The zombies were never touched: still due, never run.
    const zombieAutomations = await Promise.all(
      zombieIds.map(async (zombieId) => {
        return (
          await accept(
            refApi().show({
              params: { ref: zombieId },
              headers: SESSION_HEADERS,
            }),
            [200],
          )
        ).body;
      }),
    );
    expect(zombieAutomations).toHaveLength(12);
    for (const zombieAutomation of zombieAutomations) {
      expect(zombieAutomation.enabled).toBeFalsy();
      const [zombieTrigger] = zombieAutomation.triggers;
      if (zombieTrigger?.kind !== "loop") {
        throw new Error("Expected a loop trigger");
      }
      expect(zombieTrigger.nextRunAt).toBe(pastDue.toISOString());
      expect(zombieTrigger.lastRunAt).toBeNull();
    }
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

    // Once the owner is no longer an org member, no production user API can
    // read their automation; the cron route is infrastructure-only. Keep this
    // test-state read narrowly scoped to verifying that suspension side effect.
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

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(mainApi().list({ headers: {} }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
