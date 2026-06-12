import { randomUUID } from "node:crypto";

import {
  automationsV2ByRefContract,
  automationsV2MainContract,
} from "@vm0/api-contracts/contracts/automations-v2";
import { healthContract } from "@vm0/api-contracts/contracts/health";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroReportErrorContract } from "@vm0/api-contracts/contracts/zero-report-error";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { healthAuthProbeContract } from "../health-auth-probe";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

/*
helper gap: HOOK-01 signed callbacks still need API-visible builders for
run/chat/schedule/integration source state before they can avoid DB fixtures.
helper gap: HOOK-02 external provider webhooks still need visible source-state
builders for Stripe, Clerk, GitHub, storage, checkpoints, and generation runs.
*/

const context = testContext();
const api = createBddApi(context);
const routeMocks = createZeroRouteMocks(context);

function healthClient() {
  return setupApp({ context })(healthContract);
}

function healthAuthClient() {
  return setupApp({ context })(healthAuthProbeContract);
}

function featureSwitchesClient() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

function reportErrorClient() {
  return setupApp({ context })(zeroReportErrorContract);
}

function automationsClient() {
  return setupApp({ context })(automationsV2MainContract);
}

function automationsByRefClient() {
  return setupApp({ context })(automationsV2ByRefContract);
}

function headersFor(actor: ApiTestUser | null): {
  readonly authorization?: string;
} {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function expectRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object response body");
  }
}

describe("OPS-02: API health and auth boundary", () => {
  it("checks public health and authenticated health probe through HTTP routes", async () => {
    const admin = api.user();

    const health = await accept(healthClient().check(), [200]);
    expect(health.body).toStrictEqual({ status: "ok" });

    const unauthorized = await accept(
      healthAuthClient().check({
        headers: headersFor(null),
        query: {},
      }),
      [401],
    );
    expectApiError(unauthorized.body);
    expect(unauthorized.body.error.code).toBe("UNAUTHORIZED");

    const authenticated = await accept(
      healthAuthClient().check({
        headers: headersFor(admin),
        query: {},
      }),
      [200],
    );
    expectRecord(authenticated.body);
    expect(authenticated.body.userId).toBe(admin.userId);
    expect(authenticated.body.orgId).toBe(admin.orgId);
    expect(authenticated.body.tokenType).toBe("session");
  });
});

describe("OPS-01: feature switches and report-error routes", () => {
  it("updates, reads, merges, and deletes feature switch overrides through API", async () => {
    const admin = api.user();

    const initial = await accept(
      featureSwitchesClient().get({ headers: headersFor(admin) }),
      [200],
    );
    expect(
      initial.body.switches[FeatureSwitchKey.AutomationWebhookTriggers],
    ).toBeUndefined();

    const enabled = await accept(
      featureSwitchesClient().update({
        headers: headersFor(admin),
        body: {
          switches: {
            [FeatureSwitchKey.AutomationWebhookTriggers]: true,
            [FeatureSwitchKey.Dummy]: false,
          },
        },
      }),
      [200],
    );
    expect(
      enabled.body.switches[FeatureSwitchKey.AutomationWebhookTriggers],
    ).toBeTruthy();
    expect(enabled.body.switches[FeatureSwitchKey.Dummy]).toBeFalsy();

    const merged = await accept(
      featureSwitchesClient().update({
        headers: headersFor(admin),
        body: {
          switches: {
            [FeatureSwitchKey.Dummy]: true,
          },
        },
      }),
      [200],
    );
    expect(
      merged.body.switches[FeatureSwitchKey.AutomationWebhookTriggers],
    ).toBeTruthy();
    expect(merged.body.switches[FeatureSwitchKey.Dummy]).toBeTruthy();

    const read = await accept(
      featureSwitchesClient().get({ headers: headersFor(admin) }),
      [200],
    );
    expect(read.body.switches).toStrictEqual(merged.body.switches);

    const deleted = await accept(
      featureSwitchesClient().delete({ headers: headersFor(admin) }),
      [200],
    );
    expect(deleted.body).toStrictEqual({ deleted: true });

    const readAfterDelete = await accept(
      featureSwitchesClient().get({ headers: headersFor(admin) }),
      [200],
    );
    expect(
      readAfterDelete.body.switches[FeatureSwitchKey.Dummy],
    ).toBeUndefined();
  });

  it("reports invalid or missing failed runs as visible API errors", async () => {
    const admin = api.user();

    const invalidBody = await accept(
      reportErrorClient().submit({
        headers: headersFor(admin),
        body: {
          runId: "not-a-run-id",
          title: "Invalid run id",
        },
      }),
      [400],
    );
    expectApiError(invalidBody.body);
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    const missingRun = await accept(
      reportErrorClient().submit({
        headers: headersFor(admin),
        body: {
          runId: randomUUID(),
          title: "Missing failed run",
          description: "BDD route-level missing-run boundary",
        },
      }),
      [400],
    );
    expectApiError(missingRun.body);
    expect(missingRun.body.error.code).toBe("RUN_NOT_FOUND");
  });
});

describe("HOOK-02: webhook automation management", () => {
  it("creates, lists, deletes, and verifies webhook automation state through API", async () => {
    const admin = api.user();
    api.acceptAgentStorageWrites();

    await accept(
      featureSwitchesClient().update({
        headers: headersFor(admin),
        body: {
          switches: {
            [FeatureSwitchKey.AutomationWebhookTriggers]: true,
          },
        },
      }),
      [200],
    );

    const agent = await api.createAgent(admin, {
      displayName: "BDD Webhook Agent",
    });

    const created = await accept(
      automationsClient().create({
        headers: headersFor(admin),
        body: {
          name: "bdd-webhook",
          agentId: agent.agentId,
          instruction: "Handle signed webhook payloads",
          description: "Created by API-only BDD test",
          enabled: true,
          trigger: { kind: "webhook" },
        },
      }),
      [201],
    );
    expect(created.body.webhookSecret).toStrictEqual(expect.any(String));
    expect(created.body.automation.agentId).toBe(agent.agentId);
    expect(created.body.automation.userId).toBe(admin.userId);
    expect(created.body.automation.name).toBe("bdd-webhook");
    expect(created.body.automation.enabled).toBeTruthy();
    expect(created.body.automation.triggers).toHaveLength(1);
    const [trigger] = created.body.automation.triggers;
    expect(trigger).toMatchObject({
      kind: "webhook",
      enabled: true,
    });

    const listed = await accept(
      automationsClient().list({ headers: headersFor(admin) }),
      [200],
    );
    expect(
      listed.body.automations.some((automation) => {
        return automation.id === created.body.automation.id;
      }),
    ).toBeTruthy();
    expect(
      listed.body.automations.some((automation) => {
        return "webhookSecret" in automation;
      }),
    ).toBeFalsy();

    await accept(
      automationsByRefClient().delete({
        params: { ref: created.body.automation.id },
        headers: headersFor(admin),
      }),
      [204],
    );

    const afterDelete = await accept(
      automationsClient().list({ headers: headersFor(admin) }),
      [200],
    );
    expect(
      afterDelete.body.automations.some((automation) => {
        return automation.id === created.body.automation.id;
      }),
    ).toBeFalsy();
  });
});
