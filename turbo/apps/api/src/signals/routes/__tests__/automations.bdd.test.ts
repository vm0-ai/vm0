import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createRunsAutomationsApi,
  uniqueAutomationName,
} from "./helpers/api-bdd-runs-automations";

/**
 * AUTOMATIONS-03: the legacy automations surface is FROZEN after the
 * automation -> workflow cutover (#19959, migration 0535). Every mutating
 * route answers 403 with the workflow-trigger guidance — unconditionally, so
 * not even a feature-switch override can reopen the legacy write path — while
 * list stays readable for provenance. The run-now dispatch chain this scenario
 * used to exercise lives on the workflow trigger surface now
 * (zero-workflow-triggers tests).
 *
 * Shared-database isolation: this file never calls any cron route and creates
 * no automation rows at all, so there is nothing a foreign worker's sweep
 * could claim.
 */

const context = testContext();

const DISABLED_MESSAGE =
  "Schedule automation has been disabled. Use zero workflow trigger to create scheduled tasks.";

describe("AUTOMATIONS-03: legacy automation surface is frozen", () => {
  it("answers 403 on every mutating route and keeps list readable", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);

    // Given an authenticated org member (entitlements and agents are
    // irrelevant: the freeze guard answers before billing or agent resolution)
    const actor = bdd.user();
    const missingRef = { name: uniqueAutomationName("bdd-frozen") };

    // When the actor tries to create an automation
    // Then the freeze guard rejects it with the workflow-trigger guidance
    const created = await api.requestCreateAutomationUnchecked(
      actor,
      {
        name: uniqueAutomationName("bdd-frozen-create"),
        agentId: randomUUID(),
        prompt: "Frozen surface probe.",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      [403],
    );
    expectApiError(created.body);
    expect(created.body.error.code).toBe("FORBIDDEN");
    expect(created.body.error.message).toBe(DISABLED_MESSAGE);

    // Then every other mutating route is frozen the same way, even for refs
    // that do not exist (the guard answers before any lookup)
    const update = await api.requestUpdateAutomationUnchecked(
      actor,
      missingRef.name,
      { prompt: "New instruction" },
      [403],
    );
    expectApiError(update.body);
    expect(update.body.error.message).toBe(DISABLED_MESSAGE);

    const run = await api.requestRunAutomation(actor, randomUUID(), [403]);
    expectApiError(run.body);
    expect(run.body.error.message).toBe(DISABLED_MESSAGE);

    const deleted = await api.requestDeleteAutomation(actor, missingRef, [403]);
    expectApiError(deleted.body);
    expect(deleted.body.error.message).toBe(DISABLED_MESSAGE);

    const enabled = await api.requestEnableAutomation(actor, missingRef, [403]);
    expectApiError(enabled.body);
    expect(enabled.body.error.message).toBe(DISABLED_MESSAGE);

    const disabled = await api.requestDisableAutomation(
      actor,
      missingRef,
      [403],
    );
    expectApiError(disabled.body);
    expect(disabled.body.error.message).toBe(DISABLED_MESSAGE);

    // Then the read surface stays open: the actor can still list (empty here;
    // migrated rows remain readable provenance in production)
    const listed = await api.listAutomations(actor);
    expect(listed.automations).toStrictEqual([]);
  });
});
