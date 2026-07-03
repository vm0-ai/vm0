import { randomUUID } from "node:crypto";

import { buildInfoContract } from "@vm0/api-contracts/contracts/build-info";
import { healthContract } from "@vm0/api-contracts/contracts/health";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroReportErrorContract } from "@vm0/api-contracts/contracts/zero-report-error";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import apiPackage from "../../../../package.json";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
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

function buildInfoClient() {
  return setupApp({ context })(buildInfoContract);
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
  it("returns public build info with a configured commit SHA", async () => {
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    mockEnv("GIT_COMMIT_SHA", commitSha);

    const response = await accept(buildInfoClient().get(), [200]);

    expect(response.body).toStrictEqual({
      commitSha,
      version: apiPackage.version,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns null build info for local commit placeholders", async () => {
    mockEnv("GIT_COMMIT_SHA", "local-dev");

    const response = await accept(buildInfoClient().get(), [200]);

    expect(response.body).toStrictEqual({
      commitSha: null,
      version: apiPackage.version,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

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
    expect(initial.body.switches[FeatureSwitchKey.Dummy]).toBeUndefined();

    const enabled = await accept(
      featureSwitchesClient().update({
        headers: headersFor(admin),
        body: {
          switches: {
            [FeatureSwitchKey.Dummy]: false,
          },
        },
      }),
      [200],
    );
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

  it("stores org-scoped feature switch overrides", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = api.user({ orgId });
    const peer = api.user({ orgId });
    const outsider = api.user();

    const ownerUpdate = await accept(
      featureSwitchesClient().update({
        headers: headersFor(owner),
        body: {
          switches: {
            [FeatureSwitchKey.DataExport]: true,
            [FeatureSwitchKey.AgentUnreadIndicators]: true,
            [FeatureSwitchKey.ChatThreadEventSourcing]: true,
            [FeatureSwitchKey.Dummy]: false,
          },
        },
      }),
      [200],
    );
    expect(ownerUpdate.body.switches[FeatureSwitchKey.DataExport]).toBeTruthy();
    expect(
      ownerUpdate.body.switches[FeatureSwitchKey.AgentUnreadIndicators],
    ).toBeTruthy();
    expect(
      ownerUpdate.body.switches[FeatureSwitchKey.ChatThreadEventSourcing],
    ).toBeTruthy();
    expect(
      ownerUpdate.body.effectiveSwitches[
        FeatureSwitchKey.ChatThreadEventSourcing
      ],
    ).toBeTruthy();
    expect(ownerUpdate.body.switches[FeatureSwitchKey.Dummy]).toBeFalsy();

    const peerRead = await accept(
      featureSwitchesClient().get({ headers: headersFor(peer) }),
      [200],
    );
    expect(peerRead.body.switches[FeatureSwitchKey.DataExport]).toBeTruthy();
    expect(
      peerRead.body.switches[FeatureSwitchKey.AgentUnreadIndicators],
    ).toBeTruthy();
    expect(
      peerRead.body.switches[FeatureSwitchKey.ChatThreadEventSourcing],
    ).toBeTruthy();
    expect(
      peerRead.body.effectiveSwitches[FeatureSwitchKey.ChatThreadEventSourcing],
    ).toBeTruthy();
    expect(peerRead.body.switches[FeatureSwitchKey.Dummy]).toBeUndefined();

    const outsiderRead = await accept(
      featureSwitchesClient().get({ headers: headersFor(outsider) }),
      [200],
    );
    expect(
      outsiderRead.body.switches[FeatureSwitchKey.DataExport],
    ).toBeUndefined();
    expect(
      outsiderRead.body.switches[FeatureSwitchKey.AgentUnreadIndicators],
    ).toBeUndefined();
    expect(
      outsiderRead.body.switches[FeatureSwitchKey.ChatThreadEventSourcing],
    ).toBeUndefined();
    expect(
      outsiderRead.body.effectiveSwitches[
        FeatureSwitchKey.ChatThreadEventSourcing
      ],
    ).toBeFalsy();

    const peerUpdate = await accept(
      featureSwitchesClient().update({
        headers: headersFor(peer),
        body: {
          switches: {
            [FeatureSwitchKey.DataExport]: false,
            [FeatureSwitchKey.AgentUnreadIndicators]: false,
            [FeatureSwitchKey.ChatThreadEventSourcing]: false,
          },
        },
      }),
      [200],
    );
    expect(peerUpdate.body.switches[FeatureSwitchKey.DataExport]).toBeFalsy();
    expect(
      peerUpdate.body.switches[FeatureSwitchKey.AgentUnreadIndicators],
    ).toBeFalsy();
    expect(
      peerUpdate.body.switches[FeatureSwitchKey.ChatThreadEventSourcing],
    ).toBeFalsy();
    expect(
      peerUpdate.body.effectiveSwitches[
        FeatureSwitchKey.ChatThreadEventSourcing
      ],
    ).toBeFalsy();
    expect(peerUpdate.body.switches[FeatureSwitchKey.Dummy]).toBeUndefined();

    const ownerReadAfterPeerUpdate = await accept(
      featureSwitchesClient().get({ headers: headersFor(owner) }),
      [200],
    );
    expect(
      ownerReadAfterPeerUpdate.body.switches[FeatureSwitchKey.DataExport],
    ).toBeFalsy();
    expect(
      ownerReadAfterPeerUpdate.body.switches[
        FeatureSwitchKey.AgentUnreadIndicators
      ],
    ).toBeFalsy();
    expect(
      ownerReadAfterPeerUpdate.body.switches[
        FeatureSwitchKey.ChatThreadEventSourcing
      ],
    ).toBeFalsy();
    expect(
      ownerReadAfterPeerUpdate.body.switches[FeatureSwitchKey.Dummy],
    ).toBeFalsy();

    const deleted = await accept(
      featureSwitchesClient().delete({ headers: headersFor(owner) }),
      [200],
    );
    expect(deleted.body).toStrictEqual({ deleted: true });

    const peerReadAfterDelete = await accept(
      featureSwitchesClient().get({ headers: headersFor(peer) }),
      [200],
    );
    expect(
      peerReadAfterDelete.body.switches[FeatureSwitchKey.DataExport],
    ).toBeUndefined();
    expect(
      peerReadAfterDelete.body.switches[FeatureSwitchKey.AgentUnreadIndicators],
    ).toBeUndefined();
    expect(
      peerReadAfterDelete.body.switches[
        FeatureSwitchKey.ChatThreadEventSourcing
      ],
    ).toBeUndefined();
    expect(
      peerReadAfterDelete.body.switches[FeatureSwitchKey.Dummy],
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
