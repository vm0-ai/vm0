import {
  automationsByRefContract,
  automationsMainContract,
  automationTriggersContract,
} from "@vm0/api-contracts/contracts/automations";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import {
  type AutomationsFixture,
  deleteAutomationsScenario,
  enableAutomationsFakeKms,
  resetAutomationsFakeKms,
  seedAutomationsScenario,
} from "./helpers/automations";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { deleteFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

/**
 * Legacy automations are read-only provenance data after the automation ->
 * workflow cutover (#19959): the scheduling system (poller, cron route) and
 * every mutating route were removed (#20100). Only list/show remain so users
 * can inspect their migrated rows until the Phase B table removal (#20101).
 */

const context = testContext();
const mocks = createZeroRouteMocks(context);

const SESSION_HEADERS = { authorization: "Bearer clerk-session" } as const;

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

describe("Automations API (read-only legacy provenance)", () => {
  it("keeps seeded automations readable through list and show", async () => {
    // Seeded disabled — the frozen provenance shape every migrated row has.
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

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(mainApi().list({ headers: {} }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
